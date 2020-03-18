var AWS = require('aws-sdk')
var k8s = require('@kubernetes/client-node');
var fs = require('fs')
var yaml = require('js-yaml')
var kc = require('./kube_client')
var client = kc.makeApiClient(k8s.Extensions_v1beta1Api);
var patchClient = kc.makeApiClient(k8s.Apps_v1Api);
patchClient.defaultHeaders = {'Content-Type': 'application/strategic-merge-patch+json'}

exports.handler = async (event, context) => {
  var codepipeline = new AWS.CodePipeline();
  var jobId = event["CodePipeline.job"].id;
  var keyName = event['CodePipeline.job'].data.actionConfiguration.configuration.UserParameters
  console.log('{handler} invoked with event and context:', event, context);

  /* Helper methods */
  var putJobSuccess = (message) => {
    console.log(`{putJobSuccess} message: ${message}`);
    var params = {
      jobId: jobId
    };
    return new Promise((resolve, reject) => {
      console.log('{putJobSuccess} calling codepipeline.putJobSuccessResult');
      return codepipeline.putJobSuccessResult(params, (err, data) => {
        console.log('{putJobSuccessResult} in callback');
        if(err) {
          console.log('{putJobSuccess} codepipeline.putJobSuccessResult err: ', err);
          context.fail(err);
          return reject(err);
        } else {
          console.log('{putJobSuccess} codepipeline.putJobSuccessResult success: ', message);
          context.succeed(message);
        }
        return resolve(message);
      });
    });
  };

  var putJobFailure = (message) => {
    console.log(`{putJobFailure} message: ${message}`);
    var params = {
      jobId: jobId,
      failureDetails: {
        message: JSON.stringify(message),
        type: 'JobFailed',
        externalExecutionId: context.invokeid
      }
    };
    console.log('{putJobFailure} message stringified');
    return new Promise((resolve, reject) => {
      console.log('{putJobFailure} calling codepipeline.putJobFailureResult');
      return codepipeline.putJobFailureResult(params, (err, data) => {
        console.log('{putJobFailure} codepipeline.putJobFailureResult', err, message);
        context.fail(message);
        return reject(message);
      });
    });
  };

  var ecr = new AWS.ECR()

  /* Get latest image tag */
  var imageParams = {
    repositoryName: keyName,
    filter: { tagStatus: 'TAGGED' }
  }
  let repoImages
  try {
    repoImages = await ecr.describeImages(imageParams).promise()
  }
  catch (err) {
    console.log('{handler} ecr.describeImages:', imageParams, ' exception:', err);
    return putJobFailure(`Error fetching images for repository ${keyName}`)
  } 
  var sortedImages = repoImages.imageDetails.sort((a, b) => {
    return b.imagePushedAt - a.imagePushedAt;
  })
  var latestImage = sortedImages[0]
  if (!latestImage) {
    return putJobFailure(`Missing images for repository ${keyName}`)
  }
  var latestImageTag = latestImage.imageTags[0]

  /* Get repository URI */
  var repoParams = {
    repositoryNames: [ keyName ]
  }
  let repoData
  try {
    repoData = await ecr.describeRepositories(repoParams).promise()
  }
  catch (err) {
    console.log('{handler} ecr.describeRepositories repoParams:', repoParams, ' exception:', err);
    return putJobFailure(`Error fetching repository ${keyName} detail`)
  }
  var targetRepo = repoData.repositories[0]
  if (!targetRepo) {
    return putJobFailure(`Missing repository for name ${keyName}`)
  }
  var repoURI = targetRepo.repositoryUri

  /* FINAL IMAGE URI */
  var imageUri = `${repoURI}:${latestImageTag}`

  console.log('{handler} prepare default kubernetes client.listNamespacedDeployment');

  /* Prepare kubernetes client */
  return client.listNamespacedDeployment('default')
    .then((res) => {
      console.log('{listNamespacedDeployment.then} res: ', res);
      var deployments = res.body.items
      var existDeployment = deployments.find((item) => {
        return item.metadata.name === keyName
      })

      /* Already deployed, update the deployment */
      if (existDeployment !== undefined) {
        console.log('{listNamespacedDeployment.then} patchNamespacedDeployment:', keyName);
        return patchClient.patchNamespacedDeployment(keyName, 'default', {
          spec: {
            template: {
              spec: {
                containers: [
                  {
                    name: keyName,
                    image: imageUri
                  }
                ]
              }
            }
          }
        })
        .then(() => {
          console.log('{patchNamespacedDeployment.then} Patch success');
          return putJobSuccess("Patch success.");
        })
        .catch((err) => {
          console.log('{patchNamespacedDeployment.catch} patchNamespacedDeployment exception:', err); 
          return putJobFailure(err)
        })
      } else {
        /* Create a new deployment */
        var raw = fs.readFileSync('./deploy-first', 'utf8')

        raw = raw.replace(/\$EKS_DEPLOYMENT_NAME/g, keyName)
        raw = raw.replace(/\$DEPLY_IMAGE/g, imageUri)

        var deployConfig = yaml.safeLoad(raw)

        console.log('{listNamespacedDeployment.then} created new deployConfig:', deployConfig);

        return client.createNamespacedDeployment('default', deployConfig)
          .then(() => {
            console.log('{createNamespacedDeployment.then} success');
            return putJobSuccess("Deploy success.");
          })
          .catch((err) => {
            console.log('{createNamespacedDeployment.catch} err:', err);
            return putJobFailure(err)
          })
      }
    })
    .catch((err) => {
      console.log('{listNamespacedDeployment.catch} err:', err);
      return putJobFailure(err)
    })
}
