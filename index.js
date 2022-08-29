const path = require('path');
const core = require('@actions/core');
const aws = require('aws-sdk');
const yaml = require('yaml');
const fs = require('fs');
const crypto = require('crypto');

const MAX_WAIT_MINUTES = 360;  // 6 hours
const WAIT_DEFAULT_DELAY_SEC = 16;

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
  const maxAttempts = (waitForMinutes * 60) / WAIT_DEFAULT_DELAY_SEC;
  await ecs.waitFor('servicesStable', {
    services: [service],
    cluster: clusterName,
    $waiter: {
      delay: WAIT_DEFAULT_DELAY_SEC,
      maxAttempts: maxAttempts
    }
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

async function createSecurityGroupForLoadBalancerToService(ec2, elbv2, loadBalancerArn, serviceName, ports) {
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

  for (const port of ports) {
    await authorizeIngressFromAnotherSecurityGroup(ec2, serviceSecurityGroupId, loadBalancerSecurityGroupId, port, port);
    await authorizeEgressToAnotherSecurityGroup(ec2, loadBalancerSecurityGroupId, serviceSecurityGroupId, port, port);
  }

  return serviceSecurityGroupId;
}

function getPortsFromTaskDefinition(taskDefinition) {
  const ports = [];

  for (const container of taskDefinition.containerDefinitions) {
    for (const portMapping of container.portMappings) {
      ports.push(portMapping.hostPort);
    }
  }

  return ports;
}

function findContainerDefinition(taskDefinition, containerName) {
  for (const container of taskDefinition.containerDefinitions) {
    if (container.name === containerName) {
      return container;
    }
  }
}

async function createEcsService(ecs, elbv2, ec2, clusterName, serviceName, taskDefArn, minimumHealthyPercentage, desiredCount, enableExecuteCommand, healthCheckGracePeriodSeconds, propagateTags, enableCodeDeploy, loadBalancerArn, targetGroupArn, subnets, mainContainerName) {
  let params;

  const taskDefinition = await getTaskDefinition(ecs, taskDefArn);
  const ports = getPortsFromTaskDefinition(taskDefinition);

  const sgId = await createSecurityGroupForLoadBalancerToService(ec2, elbv2, loadBalancerArn, serviceName, ports);

  const mainContainer = findContainerDefinition(taskDefinition, mainContainerName);

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
          containerName: mainContainerName,
          containerPort: mainContainer.portMappings[0].hostPort,
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
async function updateEcsService(ecs, clusterName, service, taskDefArn, waitForService, waitForMinutes, forceNewDeployment, desiredCount) {
  core.debug('Updating the service');
  await ecs.updateService({
    cluster: clusterName,
    service: service,
    taskDefinition: taskDefArn,
    forceNewDeployment: forceNewDeployment,
    desiredCount: desiredCount,
  }).promise();

  const consoleHostname = aws.config.region.startsWith('cn') ? 'console.amazonaws.cn' : 'console.aws.amazon.com';

  core.info(`Deployment started. Watch this deployment's progress in the Amazon ECS console: https://${consoleHostname}/ecs/home?region=${aws.config.region}#/clusters/${clusterName}/services/${service}/events`);

  if (waitForService && waitForService.toLowerCase() === 'true') {
    await waitForServiceStability(ecs, service, clusterName, waitForMinutes);
  } else {
    core.debug('Not waiting for the service to become stable');
  }
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
  for (const attribute of IGNORED_TASK_DEFINITION_ATTRIBUTES) {
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

async function describeTargetGroup(elbv2, targetGroupArn) {
  const params = {
    TargetGroupArns: [
      targetGroupArn,
    ]
  };

  const response = await elbv2.describeTargetGroups(params).promise();
  return response.TargetGroups[0];
}

async function createCodeDeployApplicationIfMissing(codedeploy, applicationName) {
  if (await doesCodeDeployApplicationExist(codedeploy, applicationName)) {
    core.info("Using existing CodeDeploy Application");
    return;
  }

  core.info("Creating new CodeDeploy Application");
  await createCodeDeployApplication(codedeploy, applicationName);
}

async function doesCodeDeployApplicationExist(codedeploy, applicationName) {
  core.debug("Checking for codedeploy application");

  const params = {
    applicationName: applicationName,
  };

  try {
    const response = await codedeploy.getApplication(params).promise();
    if (response.application.applicationId) {
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
}

async function createCodeDeployApplication(codedeploy, applicationName) {
  core.debug("Creating code deploy application");
  const params = {
    applicationName: applicationName,
    computePlatform: 'ECS'
  };

  await codedeploy.createApplication(params).promise();
}

async function createCodeDeployDeploymentGroupIfMissing(codedeploy, applicationName, deploymentGroupName, serviceRoleArn, clusterName, serviceName, targetGroupsInfo, listenerArn) {
  if (await doesCodeDeployDeploymentGroupExist(codedeploy, applicationName, deploymentGroupName)) {
    core.info("Using existing CodeDeploy DeploymentGroup");
    return;
  }

  core.info("Creating new CodeDeploy DeploymentGroup");
  await createCodeDeployDeploymentGroup(codedeploy, applicationName, deploymentGroupName, serviceRoleArn, clusterName, serviceName, targetGroupsInfo, listenerArn);
}

async function doesCodeDeployDeploymentGroupExist(codedeploy, applicationName, deploymentGroupName) {
  core.debug("Checking for CodeDeploy DeploymentGroup");

  const params = {
    applicationName: applicationName,
    deploymentGroupName: deploymentGroupName,
  };

  try {
    const response = await codedeploy.getDeploymentGroup(params).promise();
    if (response.deploymentGroupInfo.deploymentGroupName) {
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
}


async function determineBlueAndGreenTargetGroup(elbv2, targetGroupArns) {
  let blueTargetGroupInfo;
  let greenTargetGroupInfo;

  core.debug("Determining which target group is Blue/Green");
  for (const targetGroupArn of targetGroupArns) {
    const targetGroupInfo = await describeTargetGroup(elbv2, targetGroupArn);

    // if the target group is being used
    if (targetGroupInfo.LoadBalancerArns.length > 0) {
      if (blueTargetGroupInfo) {
        throw new Error("Both provided target groups are in active use! Cannot use them for a Blue/Green Deployment");
      }
      blueTargetGroupInfo = targetGroupInfo;
    } else {
      if (greenTargetGroupInfo) {
        throw new Error("Neither target group is in use! A Blue/Green Deployment requires that traffic is being served first")
      }
      greenTargetGroupInfo = targetGroupInfo;
    }
  }

  return {
    blueTargetGroupInfo: blueTargetGroupInfo,
    greenTargetGroupInfo: greenTargetGroupInfo,
  };
}

async function createCodeDeployDeploymentGroup(codedeploy, applicationName, deploymentGroupName, serviceRoleArn, clusterName, serviceName, targetGroupsInfo, listenerArn) {
  core.debug("Creating code deploy deployment group");

  const params = {
    applicationName: applicationName,
    deploymentGroupName: deploymentGroupName,
    serviceRoleArn: serviceRoleArn,
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
      },
      terminateBlueInstancesOnDeploymentSuccess: {
        action: 'TERMINATE',
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
      targetGroupPairInfoList: [
        {
          prodTrafficRoute: {
            listenerArns: [
              listenerArn,
            ]
          },
          targetGroups: [
            {
              name: targetGroupsInfo.blueTargetGroupInfo.TargetGroupName
            },
            {
              name: targetGroupsInfo.greenTargetGroupInfo.TargetGroupName
            }
          ],
        },
      ]
    },
  };
  await codedeploy.createDeploymentGroup(params).promise();
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

function updateTaskDefinitionArnInAppSpec(appSpecYaml, taskDefArn) {
  for (const resource of findAppSpecValue(appSpecYaml, 'resources')) {
    for (const name in resource) {
      const resourceContents = resource[name];
      const properties = findAppSpecValue(resourceContents, 'properties');
      const taskDefKey = findAppSpecKey(properties, 'taskDefinition');
      properties[taskDefKey] = taskDefArn;
    }
  }

  return appSpecYaml;
}

function readYaml(filePath) {
  const fixedPath = path.isAbsolute(filePath) ?
      filePath :
      path.join(process.env.GITHUB_WORKSPACE, filePath);
  const fileContents = fs.readFileSync(fixedPath, 'utf8');

  return yaml.parse(fileContents);
}

async function createCodeDeployDeployment(codedeploy, service, appSpecFilePath, taskDefArn, waitForService, waitForMinutes) {
  core.debug('Updating AppSpec file with new task definition ARN');

  let deploymentGroupDetails = await codedeploy.getDeploymentGroup({
    applicationName: service,
    deploymentGroupName: service
  }).promise();
  deploymentGroupDetails = deploymentGroupDetails.deploymentGroupInfo;

  let appSpecYaml = readYaml(appSpecFilePath);
  appSpecYaml = updateTaskDefinitionArnInAppSpec(appSpecYaml, taskDefArn);

  core.debug("Got appspec file of:")
  core.debug(JSON.stringify(appSpecYaml));

  const appSpecString = JSON.stringify(appSpecYaml);
  const appSpecHash = crypto.createHash('sha256').update(appSpecString).digest('hex');

  // Start the deployment with the updated appspec contents
  core.debug('Starting CodeDeploy deployment');
  let deploymentParams = {
    applicationName: service,
    deploymentGroupName: service,
    description: `Deployment for ${service}`,
    revision: {
      revisionType: 'AppSpecContent',
      appSpecContent: {
        content: appSpecString,
        sha256: appSpecHash
      }
    }
  };

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

async function registerTaskDefinition(ecs, taskDefinitionFile) {
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

  return taskDefArn;
}

async function getTaskDefinition(ecs, taskDefinitionArn) {
  core.debug("Get task definition");
  const params = {
    taskDefinition: taskDefinitionArn,
  };
  const response = await ecs.describeTaskDefinition(params).promise();
  return response.taskDefinition;
}

async function performCodeDeployDeployment(codedeploy, serviceName, appSpecFilePath, taskDefArn, deployRoleArn, clusterName, targetGroupsInfo, listenerArn, waitForService, waitForMinutes) {
  await createCodeDeployApplicationIfMissing(codedeploy, serviceName);
  await createCodeDeployDeploymentGroupIfMissing(codedeploy, serviceName, serviceName, deployRoleArn, clusterName, serviceName, targetGroupsInfo, listenerArn);
  await createCodeDeployDeployment(codedeploy, serviceName, appSpecFilePath, taskDefArn, waitForService, waitForMinutes);
}

async function createOrUpdate(ecs, elbv2, ec2, codedeploy) {
  const taskDefinitionFile = core.getInput('task-definition', { required: true });
  const serviceName = `${core.getInput('service-name', { required: false })}-16`;
  const serviceDesiredCount = parseInt(core.getInput('service-desired-count', { required: false }));
  const serviceEnableExecuteCommandInput = core.getInput('service-enable-execute-command', { required: false });
  const serviceEnableExecuteCommand = serviceEnableExecuteCommandInput.toLowerCase() === 'true';
  const serviceHealthCheckGracePeriodSeconds = parseInt(core.getInput('service-health-check-grace-period-seconds', { required: false }));
  const servicePropagateTags = core.getInput('service-propagate-tags', { required: false });
  const serviceMinHealthyPercentage = parseInt(core.getInput('service-min-healthy-percentage', { required: false }));
  const serviceSubnets = core.getInput('service-subnets').split(',');
  const newServiceUseCodeDeployInput = core.getInput('new-service-use-codedeploy', { required: false });
  const newServiceUseCodeDeploy = newServiceUseCodeDeployInput.toLowerCase() === 'true';
  const codeDeployListenerArn = core.getInput('codedeploy-listener-arn', { required: false });
  const codeDeployLoadBalancerArn = core.getInput('codedeploy-load-balancer-arn', { required: false });
  const codeDeployClusterName = core.getInput('codedeploy-cluster-name', { required: false });
  const codeDeployAppSpecFile = core.getInput('codedeploy-appspec', { required : false }) || 'appspec.yaml';
  const codeDeployRoleArn = core.getInput('codedeploy-role-arn', { required: false });
  const targetGroupArns = core.getInput('target-group-arns').split(',');
  const cluster = core.getInput('cluster', { required: false });
  const waitForService = core.getInput('wait-for-service-stability', { required: false });
  let waitForMinutes = parseInt(core.getInput('wait-for-minutes', { required: false })) || 30;
  if (waitForMinutes > MAX_WAIT_MINUTES) {
    core.warning(`Max wait time cannot be greater than ${MAX_WAIT_MINUTES} minutes. Using ${MAX_WAIT_MINUTES} instead`);
    waitForMinutes = MAX_WAIT_MINUTES;
  }
  const forceNewDeployInput = core.getInput('force-new-deployment', { required: false }) || 'false';
  const forceNewDeployment = forceNewDeployInput.toLowerCase() === 'true';
  const taskDefArn = await registerTaskDefinition(ecs, taskDefinitionFile);
  const mainContainerName = core.getInput('main-container-name', {required: false}) || 'web';
  const clusterName = cluster ? cluster : 'default';
  const targetGroupsInfo = await determineBlueAndGreenTargetGroup(elbv2, targetGroupArns);

  let existingService = await describeServiceIfExists(ecs, serviceName, clusterName, false);
  if (existingService && existingService.status !== 'ACTIVE') {
    throw new Error(`Service is ${existingService.status}`);
  }

  if (!existingService) {
    core.info("Existing service not found. Create new service.");
    await createEcsService(ecs, elbv2, ec2, clusterName, serviceName, taskDefArn, serviceMinHealthyPercentage, serviceDesiredCount, serviceEnableExecuteCommand, serviceHealthCheckGracePeriodSeconds, servicePropagateTags, newServiceUseCodeDeploy, codeDeployLoadBalancerArn, targetGroupsInfo.blueTargetGroupInfo.TargetGroupArn, serviceSubnets, mainContainerName);
    return;
  }

  core.info("Using existing service");

  if (!existingService.deploymentController) {
    await updateEcsService(ecs, clusterName, serviceName, taskDefArn, waitForService, waitForMinutes, forceNewDeployment, serviceDesiredCount);
    return;
  }

  if (existingService.deploymentController.type === 'CODE_DEPLOY') {
    // the desired count can only be changed by updating ECS, not through CodeDeploy
    if (existingService.desiredCount !== serviceDesiredCount) {
      await updateEcsService(ecs, clusterName, serviceName, taskDefArn, waitForService, waitForMinutes, false, serviceDesiredCount);
    }
    await performCodeDeployDeployment(codedeploy, serviceName, codeDeployAppSpecFile, taskDefArn, codeDeployRoleArn, codeDeployClusterName, targetGroupsInfo, codeDeployListenerArn, waitForService, waitForMinutes);
    return;
  }

  throw new Error(`Unsupported deployment controller: ${existingService.deploymentController.type}`);
}

async function revokeLoadBalancerEgressToSecurityGroup(ec2, securityGroup, securityGroupToEgressTo, fromPort, toPort) {
  core.info("Revoking Load Balancer Egress to Security Group");
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

  core.debug(JSON.stringify(params));
  await ec2.revokeSecurityGroupEgress(params).promise();
}

async function deregisterTaskDefinition(ecs, taskDefinition) {
  core.info("Deregistering Task Definition");
  const params = {
    taskDefinition: taskDefinition,
  };
  core.debug(JSON.stringify(params));
  await ecs.deregisterTaskDefinition(params).promise();
}

async function removeSecurityGroup(ec2, groupName, vpcId) {
  core.info("Deleting Security Group");
  const existingSecurityGroup = await describeSecurityGroup(ec2, groupName, vpcId);

  const params = {
    GroupId: existingSecurityGroup.GroupId,
  };

  core.debug(JSON.stringify(params));
  await ec2.deleteSecurityGroup(params).promise();
}

async function removeEcsService(ecs, clusterName, serviceName) {
  core.info("Remove ECS Service");
  const params = {
    cluster: clusterName,
    service: serviceName,
    force: true,
  };
  core.debug(JSON.stringify(params));
  await ecs.deleteService(params).promise();
}

async function removeCodeDeployApplication(codedeploy, applicationName) {
  const params = {
    applicationName: applicationName,
  };
  await codedeploy.deleteApplication(params).promise();
}

async function remove(ecs, elbv2, ec2, codedeploy) {
  core.info("Beginning Cleanup");
  const serviceName = `${core.getInput('service-name', { required: false })}-16`;
  const cluster = core.getInput('cluster', { required: false });
  const loadBalancerArn = core.getInput('codedeploy-load-balancer-arn', { required: false });
  const serviceInfo = await describeServiceIfExists(ecs,  serviceName, cluster, true);

  const loadBalancerInfo = await describeLoadBalancer(elbv2, loadBalancerArn);

  const loadBalancerSecurityGroupId = loadBalancerInfo.SecurityGroups[0];
  const serviceSecurityGroupId = serviceInfo.networkConfiguration.awsvpcConfiguration.securityGroups[0];
  const taskDefinition = await getTaskDefinition(ecs, serviceInfo.taskDefinition);

  await deregisterTaskDefinition(ecs, serviceInfo.taskDefinition);
  await removeEcsService(ecs, cluster, serviceName);

  const ports = getPortsFromTaskDefinition(taskDefinition);
  for (const port of ports) {
    await revokeLoadBalancerEgressToSecurityGroup(ec2, loadBalancerSecurityGroupId, serviceSecurityGroupId, port, port);
  }

  await removeSecurityGroup(ec2, `load-balancer-to-${serviceName}`, loadBalancerInfo.VpcId);

  await removeCodeDeployApplication(codedeploy, serviceName);
}

async function run() {
  // my hack before we make this a custom resource
  const operation = core.getInput('operation', {required: true});

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

  try {
    if (operation === "createOrUpdate") {
      await createOrUpdate(ecs, elbv2, ec2, codedeploy);
    } else if (operation === "remove") {
      await remove(ecs, elbv2, ec2, codedeploy);
    } else {
      throw new Error(`Invalid operation: ${operation}`);
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
