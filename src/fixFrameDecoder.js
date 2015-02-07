"use strict";

var util = require('util');
var events = require('events');
var fixutil = require('./fixutils.js');
var _ = require('underscore');

//static vars
var SOHCHAR = String.fromCharCode(1);
//TODO remove the need to use standard tag names: XXX.Y.Y
var ENDOFTAG8 = 10;
var STARTOFTAG9VAL = ENDOFTAG8 + 2;
var SIZEOFTAG10 = 8;

module.exports = FixFrameDecoder;


function FixFrameDecoder(){

    this.buffer = '';
    var self = this;

    this.processData = function(data){

        self.buffer = self.buffer + data;
        while (self.buffer.length > 0) {
            //====================================Step 1: Extract complete FIX message====================================

            //If we don't have enough data to start extracting body length, wait for more data
            if (self.buffer.length <= ENDOFTAG8) {
                return;
            }

            var _idxOfEndOfTag9Str = self.buffer.substring(ENDOFTAG8).indexOf(SOHCHAR);
            var idxOfEndOfTag9 = parseInt(_idxOfEndOfTag9Str, 10) + ENDOFTAG8;

            if (isNaN(idxOfEndOfTag9)) {
                var error = '[ERROR] Unable to find the location of the end of tag 9. Message probably malformed: '
                    + self.buffer.toString();
                util.log(error);
                self.emit('error','FATAL',error);
                return;
            }


            //If we don't have enough data to stop extracting body length AND we have received a lot of data
            //then perhaps there is a problem with how the message is formatted and the session should be killed
            if (idxOfEndOfTag9 < 0 && self.buffer.length > 100) {
                var error ='[ERROR] Over 100 character received but body length still not extractable.  Message malformed: '
                    + databuffer.toString();
                util.log(error);
                self.emit('error','FATAL',error);
                return;
            }


            //If we don't have enough data to stop extracting body length, wait for more data
            if (idxOfEndOfTag9 < 0) {
                return;
            }

            var _bodyLengthStr = self.buffer.substring(STARTOFTAG9VAL, idxOfEndOfTag9);
            var bodyLength = parseInt(_bodyLengthStr, 10);
            if (isNaN(bodyLength)) {
                var error = "[ERROR] Unable to parse bodyLength field. Message probably malformed: bodyLength='"
                    + _bodyLengthStr + "', msg=" + self.buffer.toString()
                util.log(error);
                self.emit('error','FATAL',error);
                return;
            }

            var msgLength = bodyLength + idxOfEndOfTag9 + SIZEOFTAG10;

            //If we don't have enough data for the whole message, wait for more data
            if (self.buffer.length < msgLength) {
                return;
            }

            //Message received!
            var msg = self.buffer.substring(0, msgLength);
            if (msgLength == self.buffer.length) {
                self.buffer = '';
            }
            else {
                var remainingBuffer = self.buffer.substring(msgLength);
                self.buffer = remainingBuffer;
            }

            //====================================Step 2: Validate message====================================

            var calculatedChecksum = fixutil.checksum(msg.substr(0, msg.length - 7));
            var extractedChecksum = msg.substr(msg.length - 4, 3);

            if (calculatedChecksum !== extractedChecksum) {
                var error = '[WARNING] Discarding message because body length or checksum are wrong (expected checksum: '
                    + calculatedChecksum + ', received checksum: ' + extractedChecksum + '): [' + msg + ']'
                util.log(error);
                self.emit('error','ERROR',error);
                return;
            }

            self.emit('msg',msg);
        }
    }
}
util.inherits(FixFrameDecoder, events.EventEmitter);
