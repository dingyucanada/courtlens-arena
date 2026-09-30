import path from 'node:path';
import { CfnOutput, CfnResource, Duration, RemovalPolicy, Size, Stack, StackProps, aws_apigateway as apigw, aws_cloudfront as cf, aws_cloudfront_origins as origins, aws_cloudwatch as cw, aws_cognito as cognito, custom_resources as cr, aws_dynamodb as ddb, aws_ec2 as ec2, aws_ecr_assets as ecrAssets, aws_ecs as ecs, aws_iam as iam, aws_lambda as lambda, aws_logs as logs, aws_s3 as s3, aws_s3_deployment as s3deploy, aws_secretsmanager as secretsmanager, aws_stepfunctions as sfn, aws_stepfunctions_tasks as tasks } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import type { DeploymentConfig } from './config.js';

interface BroadcastStackProps extends StackProps { config: DeploymentConfig }

export class BroadcastStack extends Stack {
  constructor(scope: Construct, id: string, props: BroadcastStackProps) {
    super(scope, id, props);
    const cfg = props.config;
    const voiceProviders = cfg.voiceProviders ?? [];
    const repo = path.resolve(__dirname, '../..');
    const privateBucket = (id: string) => new s3.Bucket(this, id, {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });
    const input = privateBucket('ProjectInput');
    const releases = privateBucket('PublishedReleases');

    const records = new ddb.Table(this, 'ProjectRecords', {
      partitionKey: { name:'pk', type:ddb.AttributeType.STRING },
      sortKey: { name:'sk', type:ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      encryption: ddb.TableEncryption.AWS_MANAGED,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const pool = new cognito.UserPool(this, 'Editors', {
      selfSignUpEnabled:false,
      signInAliases:{email:true},
      autoVerify:{email:true},
      passwordPolicy:{minLength:12,requireDigits:true,requireLowercase:true,requireUppercase:true,requireSymbols:true},
      removalPolicy:RemovalPolicy.RETAIN,
    });

    const apiFn = new lambda.DockerImageFunction(this, 'BroadcastApiHandler', {
      code:lambda.DockerImageCode.fromImageAsset(repo,{file:'cloud/api/Dockerfile',platform:ecrAssets.Platform.LINUX_AMD64,
        exclude:['.git/**','.github/**','.venv/**','.env*','**/.env*','**/__pycache__/**','**/*.pyc','**/node_modules/**','node_modules/**','media/**','workspace/**','site-dist/**','infra/**','tests/**','web/**','studio/**','site/**','data/**','docs/**','templates/**']}),
      timeout:Duration.seconds(25),memorySize:1024,ephemeralStorageSize:Size.gibibytes(1),
      environment:{TABLE_NAME:records.tableName,INPUT_BUCKET:input.bucketName,RELEASE_BUCKET:releases.bucketName,MAX_UPLOAD_BYTES:String(256*1024*1024),VOICE_PROVIDER_IDS:voiceProviders.map(v=>v.provider).join(',')},
      logRetention:logs.RetentionDays.TWO_WEEKS,
    });
    records.grantReadWriteData(apiFn);
    apiFn.addToRolePolicy(new iam.PolicyStatement({actions:['s3:GetObject','s3:PutObject'],resources:[input.arnForObjects('projects/*')]}));
    apiFn.addToRolePolicy(new iam.PolicyStatement({actions:['s3:ListBucket'],resources:[input.bucketArn],conditions:{StringLike:{'s3:prefix':['projects/*/media/*']}}}));

    const api = new apigw.RestApi(this, 'BroadcastApi', {
      deployOptions:{stageName:'v1',throttlingRateLimit:5,throttlingBurstLimit:10,loggingLevel:apigw.MethodLoggingLevel.ERROR,dataTraceEnabled:false,metricsEnabled:true},
      cloudWatchRole:true,
      defaultCorsPreflightOptions:undefined,
      endpointConfiguration:{types:[apigw.EndpointType.REGIONAL]},
    });
    const auth = new apigw.CognitoUserPoolsAuthorizer(this,'EditorAuthorizer',{cognitoUserPools:[pool]});
    const prefix = api.root.addResource('api').addResource('broadcast').addResource('v1');
    prefix.addMethod('ANY',new apigw.LambdaIntegration(apiFn),{authorizer:auth,authorizationType:apigw.AuthorizationType.COGNITO});
    prefix.addProxy({anyMethod:true,defaultIntegration:new apigw.LambdaIntegration(apiFn),defaultMethodOptions:{authorizer:auth,authorizationType:apigw.AuthorizationType.COGNITO}});

    const directoryIndex = new cf.Function(this,'DirectoryIndex',{
      code:cf.FunctionCode.fromInline("function handler(event) { var r=event.request; if (r.uri.slice(-1)==='/') r.uri += 'index.html'; return r; }"),
    });
    const distribution = new cf.Distribution(this,'WatchSite', {
      defaultRootObject:'index.html',
      defaultBehavior:{origin:origins.S3BucketOrigin.withOriginAccessControl(releases),viewerProtocolPolicy:cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,allowedMethods:cf.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,cachePolicy:cf.CachePolicy.CACHING_OPTIMIZED,functionAssociations:[{eventType:cf.FunctionEventType.VIEWER_REQUEST,function:directoryIndex}]},
      additionalBehaviors:{'/api/*':{origin:new origins.HttpOrigin(`${api.restApiId}.execute-api.${this.region}.${this.urlSuffix}`,{originPath:'/v1',protocolPolicy:cf.OriginProtocolPolicy.HTTPS_ONLY}),viewerProtocolPolicy:cf.ViewerProtocolPolicy.HTTPS_ONLY,allowedMethods:cf.AllowedMethods.ALLOW_ALL,cachePolicy:cf.CachePolicy.CACHING_DISABLED,originRequestPolicy:cf.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER}},
      minimumProtocolVersion:cf.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion:cf.HttpVersion.HTTP2_AND_3,
      enableLogging:false,
    });
    new cr.AwsCustomResource(this,'UploadCorsForWatchOrigin',{
      onCreate:{service:'S3',action:'putBucketCors',parameters:{Bucket:input.bucketName,CORSConfiguration:{CORSRules:[{AllowedMethods:['PUT'],AllowedOrigins:[`https://${distribution.distributionDomainName}`],AllowedHeaders:['content-type','x-amz-meta-sha256'],MaxAgeSeconds:600}]}},physicalResourceId:cr.PhysicalResourceId.of(input.bucketName)},
      onUpdate:{service:'S3',action:'putBucketCors',parameters:{Bucket:input.bucketName,CORSConfiguration:{CORSRules:[{AllowedMethods:['PUT'],AllowedOrigins:[`https://${distribution.distributionDomainName}`],AllowedHeaders:['content-type','x-amz-meta-sha256'],MaxAgeSeconds:600}]}},physicalResourceId:cr.PhysicalResourceId.of(input.bucketName)},
      onDelete:{service:'S3',action:'deleteBucketCors',parameters:{Bucket:input.bucketName}},
      policy:cr.AwsCustomResourcePolicy.fromSdkCalls({resources:[input.bucketArn]}),
      installLatestAwsSdk:false,
    });
    const hostedDomain = `courtlens-bcast-${cfg.teamAccountId}-${cfg.allowedRegion}`;
    pool.addDomain('HostedLogin',{cognitoDomain:{domainPrefix:hostedDomain}});
    const callback = `https://${distribution.distributionDomainName}/broadcast/`;
    const client = pool.addClient('BrowserClient', {
      generateSecret:false,preventUserExistenceErrors:true,
      oAuth:{flows:{authorizationCodeGrant:true},scopes:[cognito.OAuthScope.OPENID,cognito.OAuthScope.EMAIL],callbackUrls:[callback],logoutUrls:[callback]},
    });
    // Only site files are published by the deployment; media is written under immutable releases/ keys.
    const siteDir = path.resolve(path.join(repo,'infra'),cfg.siteAssetDirectory);
    new s3deploy.BucketDeployment(this,'SiteAssets',{
      sources:[s3deploy.Source.asset(siteDir,{exclude:['**/*.mp4','**/*.mov','**/*.mkv']}),s3deploy.Source.jsonData('cloud-config.json',{
        schema:'courtlens-cloud-config/1',apiBase:'/api/broadcast/v1',region:cfg.allowedRegion,
        issuer:`https://cognito-idp.${cfg.allowedRegion}.${this.urlSuffix}/${pool.userPoolId}`,
        clientId:client.userPoolClientId,hostedUiDomain:`https://${hostedDomain}.auth.${cfg.allowedRegion}.amazoncognito.com`,redirectUri:callback,
      })],
      destinationBucket:releases,destinationKeyPrefix:'',prune:false,
      distribution,distributionPaths:['/*'],
      memoryLimit:512,
    });

    const agentImage = new ecrAssets.DockerImageAsset(this,'AgentImage',{
      directory:repo,file:'cloud/agent/Dockerfile',
      platform:ecrAssets.Platform.LINUX_ARM64,
      exclude:['.git/**','.github/**','.venv/**','.env*','**/.env*','**/__pycache__/**','**/*.pyc','**/node_modules/**','node_modules/**','media/**','workspace/**','site-dist/**','infra/**','tests/**','web/**','studio/**','site/**','data/**','docs/**','templates/**'],
    });
    const agentRole = new iam.Role(this,'AgentExecutionRole',{
      assumedBy:new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com',{
        conditions:{StringEquals:{'aws:SourceAccount':this.account},ArnLike:{'aws:SourceArn':`arn:${this.partition}:bedrock-agentcore:${this.region}:${this.account}:*`}},
      }),
    });
    agentImage.repository.grantPull(agentRole);
    agentRole.addToPolicy(new iam.PolicyStatement({actions:['s3:GetObject'],resources:[input.arnForObjects('projects/*/media/*')]}));
    agentRole.addToPolicy(new iam.PolicyStatement({actions:['bedrock:InvokeModel'],resources:[cfg.modelResourceArn]}));
    agentRole.addToPolicy(new iam.PolicyStatement({actions:['logs:CreateLogGroup','logs:DescribeLogStreams','logs:CreateLogStream','logs:PutLogEvents'],resources:[`arn:${this.partition}:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/CourtLensBroadcastAgent-*`]}));
    agentRole.addToPolicy(new iam.PolicyStatement({actions:['logs:DescribeLogGroups'],resources:[`arn:${this.partition}:logs:${this.region}:${this.account}:log-group:*`]}));
    const agent = new CfnResource(this,'BroadcastAgentRuntime',{
      type:'AWS::BedrockAgentCore::Runtime',
      properties:{AgentRuntimeName:'CourtLensBroadcastAgent',AgentRuntimeArtifact:{ContainerConfiguration:{ContainerUri:agentImage.imageUri}},RoleArn:agentRole.roleArn,ProtocolConfiguration:'HTTP',NetworkConfiguration:{NetworkMode:'PUBLIC'},EnvironmentVariables:{MODEL_ID:cfg.portalConfirmedModelId,INPUT_BUCKET:input.bucketName}},
    });
    const agentArn = agent.getAtt('AgentRuntimeArn').toString();

    // Public subnets provide ECR/S3/CloudWatch egress without a NAT gateway; the task has no inbound rule.
    const vpc = new ec2.Vpc(this,'RenderNetwork',{availabilityZones:[`${cfg.allowedRegion}a`,`${cfg.allowedRegion}b`],natGateways:0,subnetConfiguration:[{name:'egress',subnetType:ec2.SubnetType.PUBLIC}]});
    const renderSg = new ec2.SecurityGroup(this,'RenderOutboundOnly',{vpc,allowAllOutbound:true});
    const cluster = new ecs.Cluster(this,'RenderCluster',{vpc,containerInsightsV2:ecs.ContainerInsights.ENABLED});
    const renderImage = new ecrAssets.DockerImageAsset(this,'RenderImage',{
      directory:repo,file:'cloud/render/Dockerfile',platform:ecrAssets.Platform.LINUX_AMD64,
      exclude:['.git/**','.github/**','.venv/**','.env*','**/.env*','**/__pycache__/**','**/*.pyc','**/node_modules/**','node_modules/**','media/**','workspace/**','site-dist/**','infra/**','tests/**','web/**','studio/**','site/**','data/**','docs/**','templates/**'],
    });
    const renderLogs = new logs.LogGroup(this,'RenderLogs',{retention:logs.RetentionDays.TWO_WEEKS,removalPolicy:RemovalPolicy.RETAIN});
    const task = new ecs.FargateTaskDefinition(this,'CpuRenderTask',{
      cpu:2048,memoryLimitMiB:4096,ephemeralStorageGiB:40,
      runtimePlatform:{cpuArchitecture:ecs.CpuArchitecture.X86_64,operatingSystemFamily:ecs.OperatingSystemFamily.LINUX},
    });
    const voiceEnvironment: Record<string,string> = {};
    const voiceSecrets: Record<string,ecs.Secret> = {};
    for (const voice of voiceProviders) {
      const prefix = voice.provider.toUpperCase();
      const secret = secretsmanager.Secret.fromSecretCompleteArn(this,`VoiceSecret${prefix}`,voice.secretArn);
      voiceEnvironment[`COURTLENS_${prefix}_MODEL`] = voice.modelId;
      voiceEnvironment[`COURTLENS_${prefix}_VOICE_ID`] = voice.voiceId;
      voiceSecrets[`COURTLENS_${prefix}_API_KEY`] = ecs.Secret.fromSecretsManager(secret);
      secret.grantRead(task.obtainExecutionRole());
      if (voice.provider === 'minimax') voiceEnvironment.COURTLENS_MINIMAX_REGION = voice.minimaxRegion ?? 'global';
      if (voice.provider === 'stepfun') voiceEnvironment.COURTLENS_STEPFUN_API_VARIANT = voice.stepfunApiVariant ?? 'openapi';
    }
    const container = task.addContainer('worker',{
      image:ecs.ContainerImage.fromDockerImageAsset(renderImage),
      logging:ecs.LogDrivers.awsLogs({streamPrefix:'broadcast',logGroup:renderLogs}),
      environment:{TABLE_NAME:records.tableName,INPUT_BUCKET:input.bucketName,RELEASE_BUCKET:releases.bucketName,AGENT_RUNTIME_ARN:agentArn,MODEL_ID:cfg.portalConfirmedModelId,...voiceEnvironment},
      secrets:voiceSecrets,
      readonlyRootFilesystem:false,
    });
    container.addUlimits({name:ecs.UlimitName.NOFILE,softLimit:4096,hardLimit:4096});
    task.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({actions:['s3:GetObject','s3:PutObject','s3:AbortMultipartUpload','s3:ListMultipartUploadParts'],resources:[input.arnForObjects('projects/*')]}));
    task.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({actions:['s3:ListBucket'],resources:[input.bucketArn],conditions:{StringLike:{'s3:prefix':['projects/*/media/*']}}}));
    task.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({actions:['s3:PutObject','s3:AbortMultipartUpload','s3:ListMultipartUploadParts'],resources:[releases.arnForObjects('releases/*')]}));
    records.grantReadWriteData(task.taskRole);
    task.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({actions:['bedrock-agentcore:InvokeAgentRuntime'],resources:[agentArn]}));

    const failFn = new lambda.Function(this,'FailedTaskRecorder',{
      runtime:lambda.Runtime.PYTHON_3_12,handler:'fail.handler',code:lambda.Code.fromAsset(path.join(repo,'cloud','fail')),
      timeout:Duration.seconds(10),environment:{TABLE_NAME:records.tableName},logRetention:logs.RetentionDays.TWO_WEEKS,
    });
    records.grantReadWriteData(failFn);
    const run = new tasks.EcsRunTask(this,'RunBoundedWorker',{
      cluster,taskDefinition:task,containerOverrides:[{containerDefinition:container,environment:[{name:'JOB_ID',value:sfn.JsonPath.stringAt('$.jobId')},{name:'OWNER_ID',value:sfn.JsonPath.stringAt('$.ownerId')}]}],
      integrationPattern:sfn.IntegrationPattern.RUN_JOB,launchTarget:new tasks.EcsFargateLaunchTarget({platformVersion:ecs.FargatePlatformVersion.LATEST}),
      assignPublicIp:true,subnets:{subnetType:ec2.SubnetType.PUBLIC},securityGroups:[renderSg],
      timeout:Duration.minutes(18),resultPath:'$.taskResult',
    });
    const failure = new tasks.LambdaInvoke(this,'RecordWorkerFailure',{lambdaFunction:failFn,payload:sfn.TaskInput.fromObject({jobId:sfn.JsonPath.stringAt('$.jobId'),ownerId:sfn.JsonPath.stringAt('$.ownerId'),error:sfn.JsonPath.stringAt('$.error.Error')}),payloadResponseOnly:true});
    run.addCatch(failure.next(new sfn.Fail(this,'WorkerFailed')),{resultPath:'$.error'});
    const workflow = new sfn.StateMachine(this,'BoundedJobWorkflow',{
      definitionBody:sfn.DefinitionBody.fromChainable(run),
      timeout:Duration.minutes(20),
      stateMachineType:sfn.StateMachineType.STANDARD,
      logs:{destination:new logs.LogGroup(this,'WorkflowLogs',{retention:logs.RetentionDays.TWO_WEEKS,removalPolicy:RemovalPolicy.RETAIN}),level:sfn.LogLevel.ERROR,includeExecutionData:false},
      tracingEnabled:false,
    });
    workflow.grantStartExecution(apiFn);
    apiFn.addToRolePolicy(new iam.PolicyStatement({actions:['states:StopExecution'],resources:[`arn:${this.partition}:states:${this.region}:${this.account}:execution:${workflow.stateMachineName}:*`]}));
    apiFn.addEnvironment('WORKFLOW_ARN',workflow.stateMachineArn);
    new cw.Alarm(this,'WorkflowFailures',{metric:workflow.metricFailed({period:Duration.minutes(5)}),threshold:1,evaluationPeriods:1});

    new CfnOutput(this,'WatchUrl',{value:`https://${distribution.distributionDomainName}/broadcast/`});
    new CfnOutput(this,'ApiUrl',{value:`https://${distribution.distributionDomainName}/api/broadcast/v1`});
    new CfnOutput(this,'CognitoPoolId',{value:pool.userPoolId});
    new CfnOutput(this,'CognitoClientId',{value:client.userPoolClientId});
    new CfnOutput(this,'InputBucketName',{value:input.bucketName});
    new CfnOutput(this,'ReleaseBucketName',{value:releases.bucketName});
    new CfnOutput(this,'AgentRuntimeArn',{value:agentArn});
    new CfnOutput(this,'FormalReady',{value:'false — requires actual Portal/identity/model/Agent/CloudFront verification'});
  }
}
