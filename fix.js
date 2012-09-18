#!/usr/bin/env node

"use strict";

var util = require('util');
var _ = require('./deps/underscore-min.js');

exports.fixClient = function(fixVersion, senderCompID, targetCompID, options){
    var self = this;
    
    this.fixVersion = fixVersion;
    this.senderCompID = senderCompID;
    this.targetCompID = targetCompID;
}

exports.fixSession = function(fixVersion, senderCompID, targetCompID, options){
    
    this.fixVersion = fixVersion;
    this.senderCompID = senderCompID;
    this.targetCompID = targetCompID;

    //options
    this.defaultHeartbeatSeconds = options.defaultHeartbeatSeconds || 30 ;
    this.sendHeartbeats = options.sendHeartbeats || true;
    this.expectHeartbeats = options.expectHeartbeats || true;
    this.respondToLogon = options.respondToLogon || true;
    this.isDuplicateFunc = options.isDuplicateFunc || function () {return false;} ;
    this.isAuthenticFunc = options.isAuthenticFunc || function () {return true;} ;
    this.getSeqNums = options.getSeqNums || function () { return {'incomingSeqNum': 1, 'outgoingSeqNum': 1 }; } ;
    this.datastore = options.datastore || new function () {
        this.add = function(data){};
        this.each = function(){};
    } ;

    
    //runtime variables
    this.isLoggedIn = false;
    this.heartbeatIntervalID = "";
    this.timeOfLastIncoming = new Date().getTime();
    this.timeOfLastOutgoing = new Date().getTime();
    this.testRequestID = 1;
    this.incomingSeqNum = options.incomingSeqNum || 1;
    this.outgoingSeqNum = options.outgoingSeqNum || 1;
    this.isResendRequested = false;
    this.isLogoutRequested = false;
    
    var self = this;

    
    //process incoming messages
    this.processIncomingMsg = function(fix){
        self.timeOfLastIncoming = new Date().getTime();
        
        var msgType = fix['35'];
        //TODO confirm existance of tags 8,9,35,49,56,52

        //If not logged in
        if (self.isLoggedIn === false){
            
            //==Confirm first msg is logon==
            if (msgType !== 'A') {
                var errorMsg = '[FATAL] First message must be logon:' + fix;
                util.log(errorMsg);
                self.sendError("FATAL",errorMsg);
                return;
            }
            else{ //log on message
                
                if(!_.has(fix,108)){
                    var errorMsg = '[FATAL] Heartbeat message missing from logon:' + fix;
                    util.log(errorMsg);
                    self.sendError("FATAL",errorMsg);
                    return;
                }
                var _heartbeatInMilliSeconds = fix[108] ;
                //TODO if 108 missing, send error
                var heartbeatInMilliSeconds = parseInt(_heartbeatInMilliSeconds, 10) * 1000;
                
                //==Set heartbeat mechanism
                self.heartbeatIntervalID = setInterval(function () {
                    var currentTime = new Date().getTime();
                    
                    //console.log("DEBUG:"+(currentTime-self.timeOfLastOutgoing)+">"+heartbeatInMilliSeconds);   
    
                    //==send heartbeats
                    if (currentTime - self.timeOfLastOutgoing > heartbeatInMilliSeconds && self.sendHeartbeats) {
                        self.sendMsg({
                                '35': '0'
                            }); //heartbeat
                    }
    
                    //==ask counter party to wake up
                    if (currentTime - self.timeOfLastIncoming > (heartbeatInMilliSeconds * 1.5)&& self.expectHeartbeats) {
                        self.sendMsg({
                                '35': '1',
                                '112': self.testRequestID++
                            }); //test req id
                    }
    
                    //==counter party might be dead, kill connection
                    if (currentTime - self.timeOfLastIncoming > heartbeatInMilliSeconds * 2 && self.expectHeartbeats) {
                        var error = '[FATAL] No heartbeat from counter party in milliseconds ' + heartbeatInMilliSeconds * 1.5;
                        //util.debug("Interval ID:"+JSON.stringify(self.heartbeatIntervalID));
                        util.log(error);
                        self.sendError("FATAL",error);
                        return;
                    }
    
                }, heartbeatInMilliSeconds / 2); //End Set heartbeat mechanism==
                //clearInterval(self.heartbeatIntervalID); //TODO after logoff
                
                if(self.respondToLogon){
                    self.sendMsg({35:"A", 108:fix[108]}); //logon response
                }
                
                
            }
        }
        
        //==Logon successful
        self.isLoggedIn = true;
        
        //store msg to datastore
        self.datastore.add(fix);
        
        //==Process seq-reset (no gap-fill)
        if (msgType === '4' && _.isUndefined(fix['123']) || fix['123'] === 'N') {
            var resetseqnostr = fix['36'];//TODO what if 36 isn't available
            var resetseqno = parseInt(resetseqno, 10);
            if (resetseqno >= self.incomingSeqNum) {
                self.incomingSeqNum = resetseqno
            } else {
                var error = '[FATAL] Seq-reset may not decrement sequence numbers: ' + raw;
                util.log(error);
                self.sendError("FATAL",error);
                return;
            }
        }
        
        //==Check sequence numbers
        var msgSeqNumStr = fix['34'];
        var msgSeqNum = parseInt(msgSeqNumStr, 10);
        //TODO check required values, such as 34 earlier!
        
        //==expected sequence number
        if (msgSeqNum === self.incomingSeqNum) {
            self.incomingSeqNum++;
            self.isResendRequested = false;
        }
        //less than expected
        else if (msgSeqNum < self.incomingSeqNum) {
            //ignore posdup
            if (fix['43'] === 'Y') {
                return;//TODO handle this
            }
            //if not posdup, error
            else {
                var error = '[ERROR] Incoming sequence number ('+msgSeqNum+') lower than expected (' + self.incomingSeqNum+ ') : ' + raw;
                util.log(error);
                self.sendError("FATAL",error);
                return;
            }
        }
        //==greater than expected
        else {
            //is it resend request?
            if (msgType === '2') {
                //TODO remove duplication in resend processor
                //get list of msgs from archive and send them out, but gap fill admin msgs
                self.datastore.each(function(json){
                    var _msgType = json[35];
                    var _seqNo = json[34];
                    if (_.include(['A', '5', '2', '0', '1', '4'], _msgType)) {
                        //send seq-reset with gap-fill Y
                        self.sendMsg({
                                '35': '4',
                                '123': 'Y',
                                '36': _seqNo
                            });
                    } else {
                        //send msg w/ posdup Y
                        self.sendMsg(_.extend(json, {
                            '43': 'Y'
                        }));
                    }
                });

            }
            //did we already send a resend request?
            if (self.isResendRequested === false) {
                self.isResendRequested = true;
                //send resend-request
                self.sendMsg({
                        '35': '2',
                        '7': self.incomingSeqNum,
                        '16': '0'
                    });
            }
        }
        
        //==Process sequence-reset with gap-fill
        if (msgType === '4' && fix['123'] === 'Y') {
            var newSeqNoStr = fix['36'];
            var newSeqNo = parseInt(newSeqNoStr, 10);

            if (newSeqNo >= self.incomingSeqNum) {
                self.incomingSeqNum = newSeqNo;
            } else {
                var error = '[FATAL] Seq-reset may not decrement sequence numbers: ' + fix;
                util.log(error);
                self.sendError("FATAL",error);
                return;
            }
        }

        //==Check compids and version
        //TODO
        //==Process test request
        if (msgType === '1') {
            var testReqID = fix['112'];
            self.sendMsg({
                    '35': '0',
                    '112': testReqID
                });
        }
        
        //==Process resend-request
        if (msgType === '2') {
            //TODO remove duplication in resend processor
            //get list of msgs from archive and send them out, but gap fill admin msgs
            self.datastore.each(function(json){
                    var _msgType = json[35];
                    var _seqNo = json[34];
                    if (_.include(['A', '5', '2', '0', '1', '4'], _msgType)) {
                        //send seq-reset with gap-fill Y
                        self.sendMsg({
                                '35': '4',
                                '123': 'Y',
                                '36': _seqNo
                            });
                    } else {
                        //send msg w/ posdup Y
                        self.sendMsg(_.extend(json, {
                            '43': 'Y'
                        }));
                    }
                });

        }


        //==Process logout
        if (msgType === '5') {
            if (self.isLogoutRequested) {
                self.endSession();
            } else {
                self.sendMsg(fix);
            }
        }
        
        
        //pass message on to listener
        self.msgListener(fix);
    }
    
    //callback listeners
    this.msgListener = function(){};
    this.outMsgListener = function(){};
    //this may only be access by method sendError(type, msg)
    this.errorListener = function(){};
    
    
    //callback subscription methods
    this.onMsg = function(callback){ self.msgListener = callback; }
    this.onOutMsg = function(callback){ self.outMsgListener = callback; }
    this.onError = function(callback){ self.errorListener = callback; }
    
    //public methods
    this.sendError = function(type, msg){
        self.errorListener(type,msg);
        self.endSession();
    }
    
    this.endSession = function(){
        //util.debug("End session Interval ID:"+JSON.stringify(self.heartbeatIntervalID));
        clearInterval(self.heartbeatIntervalID);
        
    }
    
    this.sendMsg = function(msg){
        var fix = _.clone(msg);
        
        self.timeOfLastOutgoing = new Date().getTime();
        var prefil = {8:self.fixVersion, 49:self.senderCompID, 56:self.targetCompID, 34:(self.outgoingSeqNum++).toString(), 52: new Date().getTime() };
        
        _.extend(prefil,fix);
        self.outMsgListener(prefil);
    }
    
    this.sendLogon = function(){
        var msg = { 35:"A" };
        self.sendMsg(msg);
    }
    
}