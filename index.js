const path = require('path');
const core = require('@actions/core');
const aws = require('aws-sdk');
const yaml = require('yaml');
const fs = require('fs');
const crypto = require('crypto');

const MAX_WAIT_MINUTES = 360;  // 6 hours
const WAIT_DEFAULT_DELAY_SEC = 15;

// Attributes that are returned by DescribeTaskDefinition, but are not valid RegisterTaskDefinition inputs
const IGNORED_TASK_DEFINITION_ATTRIBUTES = [
  'compatibilities',
  'taskDefinitionArn',
  'requiresAttributes',
  'revision',
  'status',
  'registeredAt',
  'deregisteredAt',
  'registeredBy'
];

async function waitForServiceStability(ecs, service, clusterName, waitForMinutes) {
  core.debug(`Waiting for the service ${service} to become stable in cluster ${clusterName}. Will wait for ${waitForMinutes} minutes`);
  // const maxAttempts = (waitForMinutes * 60) / WAIT_DEFAULT_DELAY_SEC;
  await ecs.waitFor('servicesStable', {
    services: [service],
    cluster: clusterName,
    // $waiter: {
    //   delay: WAIT_DEFAULT_DELAY_SEC,
    //   maxAttempts: maxAttempts
    // }
  }).promise();
}

async function authorizeIngressFromAnotherSecurityGroup(ec2, securityGroup, securityGroupToIngress, fromPort, toPort) {
  core.debug("Add Ingress")
  const params = {
    GroupId: securityGroup,
    IpPermissions: [
      {
        FromPort: fromPort,
        IpProtocol: "tcp",
        ToPort: toPort,
        UserIdGroupPairs: [
          {
            Description: "HTTP access from other security group",
            GroupId: securityGroupToIngress,
          }
        ]
      }
    ]
  };

  await ec2.authorizeSecurityGroupIngress(params).promise();
}

async function authorizeEgressToAnotherSecurityGroup(ec2, securityGroup, securityGroupToEgressTo, fromPort, toPort) {
  const params = {
    GroupId: securityGroup,
    IpPermissions: [
      {
        FromPort: fromPort,
        IpProtocol: "tcp",
        UserIdGroupPairs: [
          {
            Description: "HTTP access to other security group",
            GroupId: securityGroupToEgressTo,
          }
        ],
        ToPort: toPort,
      }
    ]
  };

  core.debug("Egress this");
  core.debug(JSON.stringify(params));

  await ec2.authorizeSecurityGroupEgress(params).promise();
}

async function createNewSecurityGroup(ec2, sgName, sgDescription, vpcId) {
  core.debug("Creating Security Group");
  const params = {
    Description: sgDescription,
    GroupName: sgName,
    VpcId: vpcId
  };

  const response = await ec2.createSecurityGroup(params).promise();
  return response.GroupId;
}

async function describeSecurityGroup(ec2, sgName, vpcId) {
  core.debug("Checking if security group with name exists");
  const params = {
    Filters: [
      {
        Name: "group-name",
        Values: [
          sgName,
        ]
      },
      {
        Name: "vpc-id",
        Values: [
          vpcId,
        ]
      },
    ]
  };

  const response = await ec2.describeSecurityGroups(params).promise();

  return response.SecurityGroups[0];
}

async function describeLoadBalancer(elbv2, loadBalancerArn) {
  core.debug("Describe Load Balancer")
  const params = {
    LoadBalancerArns: [
      loadBalancerArn
    ]
  };
  const response = await elbv2.describeLoadBalancers(params).promise();

  return response.LoadBalancers[0];
}

async function createSecurityGroupForLoadBalancerToService(ec2, elbv2, loadBalancerArn, serviceName) {
  core.debug("Create Security Group for LB to Service")
  const loadBalancerInfo = await describeLoadBalancer(elbv2, loadBalancerArn);
  const vpcId = loadBalancerInfo.VpcId;

  const loadBalancerSecurityGroupId = loadBalancerInfo.SecurityGroups[0];
  const serviceSecurityGroupName = `load-balancer-to-${serviceName}`;
  const existingSecurityGroup = await describeSecurityGroup(ec2, serviceSecurityGroupName, vpcId);

  if (existingSecurityGroup != null) {
    core.debug(`Security group ${serviceSecurityGroupName} exists`);
    return existingSecurityGroup.GroupId;
  }

  core.debug(`Security group ${serviceSecurityGroupName} does not exist, creating new group`);
  const serviceSecurityGroupId = await createNewSecurityGroup(ec2, serviceSecurityGroupName, 'Load balancer to service', vpcId);

  await authorizeIngressFromAnotherSecurityGroup(ec2, serviceSecurityGroupId, loadBalancerSecurityGroupId, 8080, 8080);
  await authorizeIngressFromAnotherSecurityGroup(ec2, serviceSecurityGroupId, loadBalancerSecurityGroupId, 8125, 8125);
  await authorizeIngressFromAnotherSecurityGroup(ec2, serviceSecurityGroupId, loadBalancerSecurityGroupId, 8126, 8126);

  // the load balancer's security group must be updated as well
  await authorizeEgressToAnotherSecurityGroup(ec2, loadBalancerSecurityGroupId, serviceSecurityGroupId, 8080, 8080);
  await authorizeEgressToAnotherSecurityGroup(ec2, loadBalancerSecurityGroupId, serviceSecurityGroupId, 8125, 8125);
  await authorizeEgressToAnotherSecurityGroup(ec2, loadBalancerSecurityGroupId, serviceSecurityGroupId, 8126, 8126);

  return serviceSecurityGroupId;
}

async function createEcsService(ecs, elbv2, ec2, clusterName, serviceName, taskDefArn, waitForService, waitForMinutes, minimumHealthyPercentage, desiredCount, enableExecuteCommand, healthCheckGracePeriodSeconds, propagateTags, enableCodeDeploy, loadBalancerArn, targetGroupArn, subnets) {
  let params;

  const sgId = await createSecurityGroupForLoadBalancerToService(ec2, elbv2, loadBalancerArn, serviceName);

  if (enableCodeDeploy) {
    params = {
      serviceName: serviceName,
      cluster: clusterName,
      deploymentController: {
        type: 'CODE_DEPLOY'
      },
      desiredCount: desiredCount,
      enableExecuteCommand: enableExecuteCommand,
      healthCheckGracePeriodSeconds: healthCheckGracePeriodSeconds,
      launchType: 'FARGATE',
      propagateTags: propagateTags,
      taskDefinition: taskDefArn,
      loadBalancers: [
        {
          containerName: 'web',
          containerPort: '8080',
          targetGroupArn: targetGroupArn,
        },
      ],
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: subnets,
          assignPublicIp: 'DISABLED',
          securityGroups: [
              sgId,
          ],
        }
      },
    };
  } else {
    params = {
      serviceName: serviceName,
      cluster: clusterName,
      deploymentConfiguration: {
        deploymentCircuitBreaker: {
          enable: true,
          rollback: true,
        },
        minimumHealthyPercent: minimumHealthyPercentage,
      },
      deploymentController: {
        type: 'ECS',
      },
      desiredCount: desiredCount,
      enableExecuteCommand: enableExecuteCommand,
      healthCheckGracePeriodSeconds: healthCheckGracePeriodSeconds,
      launchType: 'FARGATE',
      propagateTags: propagateTags,
      taskDefinition: taskDefArn,
    };
  }

  core.debug("Creating Service")
  await ecs.createService(params).promise();
}

// Deploy to a service that uses the 'ECS' deployment controller
async function updateEcsService(ecs, clusterName, service, taskDefArn, waitForService, waitForMinutes, forceNewDeployment) {
  core.debug('Updating the service');
  await ecs.updateService({
    cluster: clusterName,
    service: service,
    taskDefinition: taskDefArn,
    forceNewDeployment: forceNewDeployment
  }).promise();

  const consoleHostname = aws.config.region.startsWith('cn') ? 'console.amazonaws.cn' : 'console.aws.amazon.com';

  core.info(`Deployment started. Watch this deployment's progress in the Amazon ECS console: https://${consoleHostname}/ecs/home?region=${aws.config.region}#/clusters/${clusterName}/services/${service}/events`);

  if (waitForService && waitForService.toLowerCase() === 'true') {
    await waitForServiceStability(ecs, service, clusterName, waitForMinutes);
  } else {
    core.debug('Not waiting for the service to become stable');
  }
}

// Find value in a CodeDeploy AppSpec file with a case-insensitive key
function findAppSpecValue(obj, keyName) {
  return obj[findAppSpecKey(obj, keyName)];
}

function findAppSpecKey(obj, keyName) {
  if (!obj) {
    throw new Error(`AppSpec file must include property '${keyName}'`);
  }

  const keyToMatch = keyName.toLowerCase();

  for (var key in obj) {
    if (key.toLowerCase() == keyToMatch) {
      return key;
    }
  }

  throw new Error(`AppSpec file must include property '${keyName}'`);
}

function isEmptyValue(value) {
  if (value === null || value === undefined || value === '') {
    return true;
  }

  if (Array.isArray(value)) {
    for (var element of value) {
      if (!isEmptyValue(element)) {
        // the array has at least one non-empty element
        return false;
      }
    }
    // the array has no non-empty elements
    return true;
  }

  if (typeof value === 'object') {
    for (var childValue of Object.values(value)) {
      if (!isEmptyValue(childValue)) {
        // the object has at least one non-empty property
        return false;
      }
    }
    // the object has no non-empty property
    return true;
  }

  return false;
}

function emptyValueReplacer(_, value) {
  if (isEmptyValue(value)) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.filter(e => !isEmptyValue(e));
  }

  return value;
}

function cleanNullKeys(obj) {
  return JSON.parse(JSON.stringify(obj, emptyValueReplacer));
}

function removeIgnoredAttributes(taskDef) {
  for (var attribute of IGNORED_TASK_DEFINITION_ATTRIBUTES) {
    if (taskDef[attribute]) {
      core.warning(`Ignoring property '${attribute}' in the task definition file. ` +
        'This property is returned by the Amazon ECS DescribeTaskDefinition API and may be shown in the ECS console, ' +
        'but it is not a valid field when registering a new task definition. ' +
        'This field can be safely removed from your task definition file.');
      delete taskDef[attribute];
    }
  }

  return taskDef;
}

function maintainValidObjects(taskDef) {
    if (validateProxyConfigurations(taskDef)) {
        taskDef.proxyConfiguration.properties.forEach((property, index, arr) => {
            if (!('value' in property)) {
                arr[index].value = '';
            }
            if (!('name' in property)) {
                arr[index].name = '';
            }
        });
    }

    if(taskDef && taskDef.containerDefinitions){
      taskDef.containerDefinitions.forEach((container) => {
        if(container.environment){
          container.environment.forEach((property, index, arr) => {
            if (!('value' in property)) {
              arr[index].value = '';
            }
          });
        }
      });
    }
    return taskDef;
}

function validateProxyConfigurations(taskDef){
  return 'proxyConfiguration' in taskDef && taskDef.proxyConfiguration.type && taskDef.proxyConfiguration.type == 'APPMESH' && taskDef.proxyConfiguration.properties && taskDef.proxyConfiguration.properties.length > 0;
}

async function createCodeDeployApplication(codedeploy, applicationName) {
  core.debug("Creating code deploy application");
  const params = {
    applicationName: applicationName,
    computePlatform: 'ECS'
  };

  await codedeploy.createApplication(params).promise();
}

async function createCodeDeployDeploymentGroup(codedeploy, applicationName, deploymentGroupName, serviceRoleArn, clusterName, serviceName, loadBalancerName, blueTargetGroupName, greenTargetGroupName, listenerArn) {
  core.debug("Creating code deploy deployment group");
  const params = {
    applicationName: applicationName,
    deploymentGroupName: deploymentGroupName,
    serviceRoleArn: serviceRoleArn,
    // alarmConfiguration: {
    //   alarms: [
    //     {
    //       name: 'STRING_VALUE'
    //     },
    //     /* more items */
    //   ],
    //   enabled: true || false,
    //   ignorePollAlarmFailure: true || false
    // },
    autoRollbackConfiguration: {
      enabled: true,
      events: [
        'DEPLOYMENT_FAILURE',
        'DEPLOYMENT_STOP_ON_ALARM',
        'DEPLOYMENT_STOP_ON_REQUEST',
      ]
    },
    blueGreenDeploymentConfiguration: {
      deploymentReadyOption: {
        actionOnTimeout: 'CONTINUE_DEPLOYMENT',
        // waitTimeInMinutes: '30'
      },
      terminateBlueInstancesOnDeploymentSuccess: {
        action: 'TERMINATE',
        // terminationWaitTimeInMinutes: '5'
      }
    },
    deploymentConfigName: 'CodeDeployDefault.ECSAllAtOnce',
    deploymentStyle: {
      deploymentOption: 'WITH_TRAFFIC_CONTROL',
      deploymentType: 'BLUE_GREEN'
    },
    ecsServices: [
      {
        clusterName: clusterName,
        serviceName: serviceName
      },
    ],
    loadBalancerInfo: {
      // elbInfoList: [
      //   {
      //     name: loadBalancerName,
      //   },
      // ],
      // targetGroupInfoList: [
      //   {
      //     name: targetGroupName,
      //   },
      // ],
      targetGroupPairInfoList: [
        {
          prodTrafficRoute: {
            listenerArns: [
              listenerArn,
            ]
          },
          targetGroups: [
            {
              name: blueTargetGroupName
            },
            {
              name: greenTargetGroupName
            }
          ],
        },
      ]
    },
  };
  await codedeploy.createDeploymentGroup(params).promise();
}

// Deploy to a service that uses the 'CODE_DEPLOY' deployment controller
async function createCodeDeployDeployment(codedeploy, clusterName, service, taskDefArn, waitForService, waitForMinutes) {
  core.debug('Updating AppSpec file with new task definition ARN');

  let codeDeployAppSpecFile = core.getInput('codedeploy-appspec', { required : false });
  codeDeployAppSpecFile = codeDeployAppSpecFile ? codeDeployAppSpecFile : 'appspec.yaml';

  // let codeDeployApp = core.getInput('codedeploy-application', { required: false });
  // codeDeployApp = codeDeployApp ? codeDeployApp : `AppECS-${clusterName}-${service}`;
  //
  // let codeDeployGroup = core.getInput('codedeploy-deployment-group', { required: false });
  // codeDeployGroup = codeDeployGroup ? codeDeployGroup : `DgpECS-${clusterName}-${service}`;

  let codeDeployDescription = core.getInput('codedeploy-deployment-description', { required: false });

  let codeDeployApp = service;
  let codeDeployGroup = service;

  let deploymentGroupDetails = await codedeploy.getDeploymentGroup({
    applicationName: codeDeployApp,
    deploymentGroupName: codeDeployGroup
  }).promise();
  deploymentGroupDetails = deploymentGroupDetails.deploymentGroupInfo;

  // Insert the task def ARN into the appspec file
  const appSpecPath = path.isAbsolute(codeDeployAppSpecFile) ?
    codeDeployAppSpecFile :
    path.join(process.env.GITHUB_WORKSPACE, codeDeployAppSpecFile);
  const fileContents = fs.readFileSync(appSpecPath, 'utf8');

  const appSpecContents = yaml.parse(fileContents);

  core.debug("Got appspec file of:")
  core.debug(JSON.stringify(appSpecContents));

  // for (var resource of findAppSpecValue(appSpecContents, 'resources')) {
  //   for (var name in resource) {
  //     const resourceContents = resource[name];
  //     const properties = findAppSpecValue(resourceContents, 'properties');
  //     const taskDefKey = findAppSpecKey(properties, 'taskDefinition');
  //     properties[taskDefKey] = taskDefArn;
  //   }
  // }

  const appSpecString = JSON.stringify(appSpecContents);
  const appSpecHash = crypto.createHash('sha256').update(appSpecString).digest('hex');

  // Start the deployment with the updated appspec contents
  core.debug('Starting CodeDeploy deployment');
  let deploymentParams = {
    applicationName: codeDeployApp,
    deploymentGroupName: codeDeployGroup,
    revision: {
      revisionType: 'AppSpecContent',
      appSpecContent: {
        content: appSpecString,
        sha256: appSpecHash
      }
    }
  };
  // If it hasn't been set then we don't even want to pass it to the api call to maintain previous behaviour.
  if (codeDeployDescription) {
    deploymentParams.description = codeDeployDescription;
  }
  const createDeployResponse = await codedeploy.createDeployment(deploymentParams).promise();
  core.setOutput('codedeploy-deployment-id', createDeployResponse.deploymentId);
  core.info(`Deployment started. Watch this deployment's progress in the AWS CodeDeploy console: https://console.aws.amazon.com/codesuite/codedeploy/deployments/${createDeployResponse.deploymentId}?region=${aws.config.region}`);

  // Wait for deployment to complete
  if (waitForService && waitForService.toLowerCase() === 'true') {
    // Determine wait time
    const deployReadyWaitMin = deploymentGroupDetails.blueGreenDeploymentConfiguration.deploymentReadyOption.waitTimeInMinutes;
    const terminationWaitMin = deploymentGroupDetails.blueGreenDeploymentConfiguration.terminateBlueInstancesOnDeploymentSuccess.terminationWaitTimeInMinutes;
    let totalWaitMin = deployReadyWaitMin + terminationWaitMin + waitForMinutes;
    if (totalWaitMin > MAX_WAIT_MINUTES) {
      totalWaitMin = MAX_WAIT_MINUTES;
    }
    const maxAttempts = (totalWaitMin * 60) / WAIT_DEFAULT_DELAY_SEC;

    core.debug(`Waiting for the deployment to complete. Will wait for ${totalWaitMin} minutes`);
    await codedeploy.waitFor('deploymentSuccessful', {
      deploymentId: createDeployResponse.deploymentId,
      $waiter: {
        delay: WAIT_DEFAULT_DELAY_SEC,
        maxAttempts: maxAttempts
      }
    }).promise();
  } else {
    core.debug('Not waiting for the deployment to complete');
  }
}

async function describeServiceIfExists(ecs, service, clusterName, errorIfDoesntExist){
  const describeResponse = await ecs.describeServices({
    services: [service],
    cluster: clusterName
  }).promise();

  if (errorIfDoesntExist && describeResponse.failures && describeResponse.failures.length > 0) {
    const failure = describeResponse.failures[0];
    throw new Error(`${failure.arn} is ${failure.reason}`);
  }

  return describeResponse.services[0];
}

async function run() {
  try {
    const ecs = new aws.ECS({
      customUserAgent: 'amazon-ecs-deploy-task-definition-for-github-actions'
    });
    const elbv2 = new aws.ELBv2({
      customUserAgent: 'amazon-elbv2-deploy-task-definition-for-github-actions'
    });
    const ec2 = new aws.EC2({
      customUserAgent: 'amazon-ec2-deploy-task-definition-for-github-actions',

    });

    const codedeploy = new aws.CodeDeploy({
      customUserAgent: 'amazon-codedeploy-deploy-task-definition-for-github-actions'
    });

    // Get inputs
    const taskDefinitionFile = core.getInput('task-definition', { required: true });

    const service = `${core.getInput('service-name', { required: false })}-10`;

    core.debug(`Service Name: ${service}`);


    const serviceDesiredCount = parseInt(core.getInput('service-desired-count', { required: false }));
    const serviceEnableExecuteCommandInput = core.getInput('service-enable-execute-command', { required: false });
    const serviceEnableExecuteCommand = serviceEnableExecuteCommandInput.toLowerCase() === 'true';
    const serviceHealthCheckGracePeriodSeconds = parseInt(core.getInput('service-health-check-grace-period-seconds', { required: false }));
    const servicePropagateTags = core.getInput('service-propagate-tags', { required: false });
    const serviceMinHealthyPercentage = parseInt(core.getInput('service-min-healthy-percentage', { required: false }));
    const serviceSubnets = core.getInput('service-subnets').split(',');


    const newServiceUseCodeDeployInput = core.getInput('new-service-use-codedeploy', { required: false });
    const newServiceUseCodeDeploy = newServiceUseCodeDeployInput.toLowerCase() === 'true';

    const codeDeployBlueTargetGroupName = core.getInput('codedeploy-blue-target-group-name', { required: false });
    const codeDeployBlueTargetGroupArn = core.getInput('codedeploy-blue-target-group-arn', { required: false });
    const codeDeployGreenTargetGroupName = core.getInput('codedeploy-green-target-group-name', { required: false });
    const codeDeployListenerArn = core.getInput('codedeploy-listener-arn', { required: false });
    const codeDeployLoadBalancerArn = core.getInput('codedeploy-load-balancer-arn', { required: false });
    const codeDeployClusterName = core.getInput('codedeploy-cluster-name', { required: false });

    const codeDeployRoleArn = core.getInput('codedeploy-role-arn', { required: false });

    const cluster = core.getInput('cluster', { required: false });
    const waitForService = core.getInput('wait-for-service-stability', { required: false });
    let waitForMinutes = parseInt(core.getInput('wait-for-minutes', { required: false })) || 30;
    if (waitForMinutes > MAX_WAIT_MINUTES) {
      waitForMinutes = MAX_WAIT_MINUTES;
    }

    const forceNewDeployInput = core.getInput('force-new-deployment', { required: false }) || 'false';
    const forceNewDeployment = forceNewDeployInput.toLowerCase() === 'true';

    // Register the task definition
    core.debug('Registering the task definition');
    const taskDefPath = path.isAbsolute(taskDefinitionFile) ?
      taskDefinitionFile :
      path.join(process.env.GITHUB_WORKSPACE, taskDefinitionFile);
    const fileContents = fs.readFileSync(taskDefPath, 'utf8');
    const taskDefContents = maintainValidObjects(removeIgnoredAttributes(cleanNullKeys(yaml.parse(fileContents))));
    let registerResponse;
    try {
      registerResponse = await ecs.registerTaskDefinition(taskDefContents).promise();
    } catch (error) {
      core.setFailed("Failed to register task definition in ECS: " + error.message);
      core.debug("Task definition contents:");
      core.debug(JSON.stringify(taskDefContents, undefined, 4));
      throw(error);
    }
    const taskDefArn = registerResponse.taskDefinition.taskDefinitionArn;
    core.setOutput('task-definition-arn', taskDefArn);

    // Update the service with the new task definition
    if (service) {
      const clusterName = cluster ? cluster : 'default';

      let serviceResponse = await describeServiceIfExists(ecs, service, clusterName, false);

      // if (!serviceResponse) {
        core.debug("Existing service not found. Create new service.");
        await createEcsService(ecs, elbv2, ec2, clusterName, service, taskDefArn, waitForService, waitForMinutes, serviceMinHealthyPercentage, serviceDesiredCount, serviceEnableExecuteCommand, serviceHealthCheckGracePeriodSeconds, servicePropagateTags, newServiceUseCodeDeploy, codeDeployLoadBalancerArn, codeDeployBlueTargetGroupArn, serviceSubnets);
        serviceResponse = await describeServiceIfExists(ecs, service, clusterName, true);
      // } else if (serviceResponse.status != 'ACTIVE') {
      //   throw new Error(`Service is ${serviceResponse.status}`);
      // }

      // if (!serviceResponse.deploymentController) {
      //   // Service uses the 'ECS' deployment controller, so we can call UpdateService
      //   await updateEcsService(ecs, clusterName, service, taskDefArn, waitForService, waitForMinutes, forceNewDeployment);
      // } else if (serviceResponse.deploymentController.type == 'CODE_DEPLOY') {
        // Service uses CodeDeploy, so we should start a CodeDeploy deployment

        await createCodeDeployApplication(codedeploy, service);
        await createCodeDeployDeploymentGroup(codedeploy, service, service, codeDeployRoleArn, codeDeployClusterName, service, serviceResponse.loadBalancers[0].loadBalancerName, codeDeployBlueTargetGroupName, codeDeployGreenTargetGroupName, codeDeployListenerArn);
        await createCodeDeployDeployment(codedeploy, codeDeployClusterName, service, taskDefArn, waitForService, waitForMinutes);
      // } else {
      //   throw new Error(`Unsupported deployment controller: ${serviceResponse.deploymentController.type}`);
      // }
    } else {
      core.debug('Service was not specified, no service updated');
    }
  }
  catch (error) {
    core.setFailed(error.message);
    core.debug(error.stack);
  }
}

module.exports = run;

/* istanbul ignore next */
if (require.main === module) {
    run();
}

// if (require.main === module) {
//   const ecs = new aws.ECS({
//     customUserAgent: 'amazon-ecs-deploy-task-definition-for-github-actions'
//   });
//
//   waitForServiceStability(ecs, 'zeus-geored-webapp-pr-351-2', 'zeus-geored-webapp-pr-351-ecs-us-east-2-cluster7C2BBDA8-m6H6xDvYk7kz', 30);
// }
