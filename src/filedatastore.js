"use strict";

var util = require('util');
var fs = require('fs');
var _ = require('underscore');

exports.filedatastore = datastore;

function datastore(id) {
  console.log("Using file data store for messages");
  return new function() {
    this.add = function(id, data) {
      console.log("Appending line to file " + id + ":" + data);
      fs.appendFile("logs/" + id, data + "\n", function(error) {
        if (error) {
          console.log("ERROR writing data to file " + id + " because of error:" + error);
        }
      });
    };
    this.each = function(id, func) {
      console.log("Reading from file " + id);
      //fs.exists("logs/"+id, function(exists){
      if (fs.existsSync("logs/" + id)) {
        //if(exists){
        console.log("Message file for id " + id + " exists. Reading now.");
        var stream = fs.createReadStream("logs/" + id, {
          flags: 'r',
          encoding: 'ascii'
        });
        stream.on('data', function(data) {
          console.log("Restoring messages: " + data);
          func(data, false);
        });
        stream.on('end', function() {
          console.log("Done reading resync file for id " + id);
          func(null, true);
        });
      } else {
        console.log("No message file for id " + id + " exists");
        func(null, true);
      }
      //});
    };
  }
}