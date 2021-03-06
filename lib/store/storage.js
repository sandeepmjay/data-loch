/**
 * Copyright ©2018. The Regents of the University of California (Regents). All Rights Reserved.
 *
 * Permission to use, copy, modify, and distribute this software and its documentation
 * for educational, research, and not-for-profit purposes, without fee and without a
 * signed licensing agreement, is hereby granted, provided that the above copyright
 * notice, this paragraph and the following two paragraphs appear in all copies,
 * modifications, and distributions.
 *
 * Contact The Office of Technology Licensing, UC Berkeley, 2150 Shattuck Avenue,
 * Suite 510, Berkeley, CA 94720-1620, (510) 643-7201, otl@berkeley.edu,
 * http://ipira.berkeley.edu/industry-info for commercial licensing opportunities.
 *
 * IN NO EVENT SHALL REGENTS BE LIABLE TO ANY PARTY FOR DIRECT, INDIRECT, SPECIAL,
 * INCIDENTAL, OR CONSEQUENTIAL DAMAGES, INCLUDING LOST PROFITS, ARISING OUT OF
 * THE USE OF THIS SOFTWARE AND ITS DOCUMENTATION, EVEN IF REGENTS HAS BEEN ADVISED
 * OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * REGENTS SPECIFICALLY DISCLAIMS ANY WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE. THE
 * SOFTWARE AND ACCOMPANYING DOCUMENTATION, IF ANY, PROVIDED HEREUNDER IS PROVIDED
 * "AS IS". REGENTS HAS NO OBLIGATION TO PROVIDE MAINTENANCE, SUPPORT, UPDATES,
 * ENHANCEMENTS, OR MODIFICATIONS.
 */

var _ = require('lodash');
var AWS = require('aws-sdk');
var async = require('async');
var config = require('config');
var crypto = require('crypto');
var fs = require('fs');
var listAllObjects = require('s3-list-all-objects');
var moment = require('moment');
var request = require('request');
var util = require('util');

var log = require('../core/logger')('store/storage');

var s3Params = {
  accessKeyId: config.get('aws.credentials.accessKeyId'),
  secretAccessKey: config.get('aws.credentials.secretAccessKey'),
  region: config.get('datalake.s3.region'),
  apiVersion: '2006-03-01',
  useAccelerateEndpoint: true
};

var s3 = new AWS.S3(s3Params);
var s3Stream = require('s3-upload-stream')(new AWS.S3(s3Params));

/**
 * Generate a daily hash using combination of date and string values.
 *
 * @param  {Function}           callback                    Standard callback function
 * @param  {String[]}           callback.generatedHash      The filenames of the files that have been downloaded
 */
var generateHash = module.exports.generateHash = function() {
  var date = moment().format('YYYY-MM-DD');
  // Add the platform URL to the list of fields to use to generate a uuid
  var fields = _.union([ date ]);
  // Create an MD5 hash out of the fields
  var generatedHash = crypto.createHash('md5').update(fields.join('')).digest('hex');
  var dailyHash = generatedHash + '-' + date;

  return dailyHash;
};

/**
 * Download the complete snapshot of Canvas Redshift data files. This api call
 * retrieves full and partial file dumps up until the last full dump.
 * The extracts are organized in the S3 bucket to facilitate creation of external schema structures.
 * A daily hash is created with a combination of a pre selected string+date to create a per day folder
 * in the S3 data lake bucket where all the extracts dowloaded for the day reside.
 *
 * @param  {Object}           data                   Contents of the file
 * @param  {String}           filename               Name of the file downloaded from cnavas data
 * @param  {String}           table                  Table name that the file is a partition of
 * @param  {Function}         callback               Standard callback function
 * @param  {Object}           callback.err           An error object, if any
 */
var storeExtractsOnS3 = module.exports.storeExtractsOnS3 = function(file, callback) {
  // Generates a daily hash to house the canvas-data external schema structure.
  var dailyHash = generateHash();
  var path = '';

  if (file.table !== 'requests') {
    path = util.format('%s/%s/%s/%s',
      config.get('datalake.canvasData.directory.daily'),
      dailyHash,
      file.table,
      file.filename);

  } else {
    path = util.format('%s/%s/%s',
      config.get('datalake.canvasData.directory.currentTerm'),
      file.table,
      file.filename);
  }

  var putParams = {
    Bucket: config.get('datalake.s3.bucket'),
    Key: path,
    ContentType: 'text/plain',
    ContentEncoding: 'gzip',
    ServerSideEncryption: 'AES256'
  };

  // Create the S3 upload stream.
  var s3upload = s3Stream.upload(putParams);
  var start = Date.now();

  // TODO: Add metadata table updates once s3 uploads are complete or when errors occur.
  // error handling for s3 upload streams.
  s3upload.on('error', function(err) {
    log.error({err: err, file: file.filename}, 'Error streaming file part to S3 bucket.');
  });

  s3upload.on('uploaded', function() {
    var end = Date.now();
    log.info({file: file.filename, duration: end - start}, 'Finished multi part upload of the Canvas data file to S3');
  });

  // Get the data dump file from Canvas Data API and return a callback if the dump is available.
  // The data dump will be uploaded asynchronouly after sending the acknowledgement.
  // TODO: Write the processing result to the metadata table once the file is processed. The table can
  // be used to keep track of files that had issues while uploading and can be retried.
  request(file.url)
    .on('response', function(res) {
      if (res.statusCode === 200) {
        res.pipe(s3upload)
          .on('error', function(err) {
            log.error(err);
            log.error({err: err, file: file.filename}, 'Unable to gunzip Canvas data file stream');
          });

      } else if (res.statusCode === 400) {
        log.error({code: res.statusCode, msg: 'Bad request. Check if file urls are correct'});
      } else if (res.statusCode === 404) {
        log.error({code: res.statusCode, msg: 'Requested file not found'});
      } else if (res.statusCode === 403) {
        log.error({code: res.statusCode, msg: 'Authorization error. Check if Canvas data file url expired'});
      } else if (res.statusCode === 500) {
        log.error({code: res.statusCode, msg: 'Internal error occured on canvas data api'});
      } else if (res.statusCode === 502) {
        log.error({code: res.statusCode, msg: 'Bad Gateway'});
      } else if (res.statusCode === 503) {
        log.error({code: res.statusCode, msg: 'Service Unavailable. Check if the canvas data api is correct and active'});
      } else {
        log.error({code: res.statusCode, msg: 'Status not 200. Unhandled error. Refer the status code to debug'});
      }

      return callback();

    })
    .on('error', function(err) {
      log.error(err);
      log.error({err: err, file: file.filename}, 'Unknown exception. Possible timeouts while hitting canvas data api for s3 uploads');
    });
};

/**
 * Delete objects from S3 for a given bucket and objects to be deleted as a list
 *
 * @param  {Object}           params                 Parameters for S3 objects to be deleted in a bucket
 * @param  {Function}         callback               Standard callback function
 * @param  {Object}           callback.err           An error object, if any
 */
var deleteObjectsFromS3 = module.exports.deleteObjectsFromS3 = function(params, callback) {

  s3.deleteObjects(params, function(err, data) {
    if (err) {
      log.error(err, err.stack);
      return callback(err);
    }

    log.info('Successfully deleted obsolete object');
    log.info(data);
    return callback();
  });

};

/**
 * Returns an array with arrays of the given size.
 *
 * @param sourceArray     {Array}     Array to be split in to chunks
 * @param chunkSize      {Integer}   Size of every group
 */
var chunkArray = module.exports.chunkArray = function(sourceArray, chunkSize) {
  var index = 0;
  var arrayLength = sourceArray.length;
  var tempArray = [];

  for (index = 0; index < arrayLength; index += chunkSize) {
    chunk = sourceArray.slice(index, index + chunkSize);
    // Do something if you want with the group
    tempArray.push(chunk);
  }

  return tempArray;
};

/**
 * Download the complete snapshot of Canvas Redshift data files. This api call
 * retrieves full and partial file dumps to perform a canavs data refresh on the data loch. Requests related to
 * only current term are uploaded to S3. The rest are organized on a daily basis.
 * A daily hash is created with a combination of a pre selected stridate to create a per day folder
 * in the S3 data lake bucket where all the extracts dowloaded for the day reside.
 * Checks are performed to see if the file already exists. If they do, they are skipped and only the new file
 * are uploaded.
 *
 * @param  {String}           filename               Name of the file downloaded from cnavas data
 * @param  {Function}         callback               Standard callback function
 * @param  {Object}           callback.err           An error object, if any
 */
var uploadFileIfNotExists = module.exports.uploadFileIfNotExists = function(file, callback) {
  var dailyHash = generateHash();
  var path = '';
  if (file.table !== 'requests') {
    path = util.format('%s/%s/%s/%s',
      config.get('datalake.canvasData.directory.daily'),
      dailyHash,
      file.table,
      file.filename);
  } else {
    path = util.format('%s/%s/%s',
      config.get('datalake.canvasData.directory.currentTerm'),
      file.table,
      file.filename);
  }

  var getParams = {
    Bucket: config.get('datalake.s3.bucket'),
    Key: path
  };

  // The code checks if the canvas data dump for a specific table has been already uploaded on the S3 location.
  // If it does, it skips it. If it is not found, then it will upload the data dump file in S3 location.
  s3.headObject(getParams, function(err, data) {
    if (err) {
      // If file is not found upload it to S3 using S3 put
      if (err.hasOwnProperty('statusCode')) {
        if (err.statusCode === 404) {
          log.info('File not uploaded previously on S3. Uploading to appropriate S3 location.');
          // organize and store canvas data files in the data lake on S3 buckets
          storeExtractsOnS3(file, function(err) {
            if (err) {
              log.error({err: err, file: file.filename}, 'Error uploading data dump to s3');
              return callback(err);
            }

            log.info({file: file.filename}, 'Uploading new data dump to s3 location');
            return callback(null, 'File upload to s3 in progress');
          });

        } else if (err.statusCode === 403) {
          log.error({err: err}, 'Possible S3 authorization failure. Check permissions');
          return callback({code: 403, msg: err.message});

        } else if (err.statusCode === 400) {
          log.error({err: err}, 'Possible bad request or S3 params failure. Check if S3 multi part uploads or transfer acceleration is enabled');
          return callback({code: 400, msg: err.message});

        } else {
          log.error({err: err, statusCode: err.statusCode}, 'Possibly internal server errors. Refer status code.');
          return callback({code: err.statusCode, msg: err.message});
        }

      } else {
        // TODO: Error handling will be further improved once metadata collection process is added.
        log.error({err: err}, 'Uncaught exception occured.');
        return callback({code: 500, msg: err.message});

      }

    } else if (data) {
      log.info('File already exists. Skipping');
      return callback(null, 'File already exists. Skipping');

    }
  });
};

/**
 * We compare the list of objects in S3 bucket with the list of filenames obtained /sync API.
 * Mark files as obselete and create a finalized list. Create batches and trigger S3 batch
 * deletion delete method to perform the clean up.
 *
 * @param  {String}           latestSyncFileNames    Name of the file downloaded from cnavas data
 * @param  {Function}         callback               Standard callback function
 * @param  {Object}           callback.err           An error object, if any
 */
var cleanUpObsoleteFiles = module.exports.cleanUpObsoleteFiles = function(latestSyncFileNames, callback) {
  // Get prefixed objects
  var bucket = config.get('datalake.s3.bucket');
  var path = util.format('%s/%s/',
    config.get('datalake.canvasData.directory.currentTerm'),
    'requests'
  );
  var obsoleteFiles = [];

  listAllObjects({bucket: bucket, prefix: path}, function(err, data) {
    if (err) {
      log.error('Could not list all the objects in the bucket.');
      return callback(err);

    }

    log.info('Got ' + data.length + ' objects with prefix.');
    async.eachSeries(data, function(s3File, done) {
      var s3FileName = s3File.Key.split(path)[1];
      var s3Key = s3File.Key;
      var s3FileFound = latestSyncFileNames.find(function(filename) {
        return filename === s3FileName;
      });

      if (!s3FileFound) {
        deleteFile = {Key: s3Key};
        obsoleteFiles.push(deleteFile);
      }

      setImmediate(done);

    }, function() {

      if (obsoleteFiles.length) {
        // S3 batch delete API accepts 1000 objects as an XML input.
        // We create mutiple chunks of size 1000 and perform batch deletions.
        var obsoleteFilesArrayChunks = chunkArray(obsoleteFiles, 999);
        log.info('No. of obsolete files marked for S3 batch object deletion: ' + obsoleteFiles.length);

        async.eachSeries(obsoleteFilesArrayChunks, function(obsoleteFileChunk, next) {
          var deleteParams = {
            Bucket: bucket,
            Delete: {
              // Required paramter: objects to deleted. Max permitted list size for batch deletion is 1000 objects.
              Objects: obsoleteFileChunk
            }
          };

          deleteObjectsFromS3(deleteParams, function(err) {
            if (err) {
              return next(err);
            }

            return next();
          });

        }, function(err) {
          if (err) {
            log.error(err, err.stack);
            return callback(err);
          }

          log.info('Completed clean up of obsolete Files. All Done.');
          return callback();
        });

      } else {
        log.info('No obsolete files found. Refresh successful.');
        return callback();

      }
    });
  });
};
