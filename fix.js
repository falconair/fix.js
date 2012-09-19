#!/usr/bin/env node

"use strict";

var util = require('util');
var net = require('net');
var fixutils = require('./fixutils.js');
var _ = require('./deps/underscore-min.js');

exports.FIXClient = function(fixVersion, senderCompID, targetCompID, options){
    var self = this;
    
    var socket = null;
    
    this.createConnection = function(options, listener){
        self.socket = net.createConnection(options,function(){
            
            //client connected, create fix session
            var fixFrameDecoder = new FixFrameDecoder();
            var session = new FIXSession(fixVersion, senderCompID, targetCompID, options);

            session.onOutMsg(function(msg){
                var outstr = fixutils.convertMapToFIX(msg);
                socket.write(outstr);
                
            });
            session.onEndSession(function(){
                socket.end();
            });

            
            socket.on('data',function(data){
                //Todo, convert to FIX
                fixFrameDecoder.onMsg(function(data){
                    session.processIncomingMsg(data);
                });
                fixFrameDecoder.processInput(data);
                fixFrameDecoder.onError(function(type, error){
                });
            });
            
            //pass on this session to client
            listener(session);
            
        });
    }
    

}

exports.FIXSession = function(fixVersion, senderCompID, targetCompID, options){
    
    this.fixVersion = fixVersion;
    this.senderCompID = senderCompID;
    this.targetCompID = targetCompID;

    //behavior control variables
    this.shouldSendHeartbeats = options.shouldSendHeartbeats || true;
    this.shouldExpectHeartbeats = options.shouldExpectHeartbeats || true;
    this.shouldRespondToLogon = options.shouldRespondToLogon || true;
    this.isDuplicateFunc = options.isDuplicateFunc || function () {return false;} ;
    this.isAuthenticFunc = options.isAuthenticFunc || function () {return true;} ;

    //options
    var defaultHeartbeatSeconds = options.defaultHeartbeatSeconds || 30 ;
    this.datastore = options.datastore || new function () {
        this.add = function(data){};
        this.each = function(){};
    } ;


    //transient variable (nothing to do with state)
    this.heartbeatIntervalID = "";

    //runtime variables 
    var isLoggedIn = false;
    var timeOfLastIncoming = new Date().getTime();
    var timeOfLastOutgoing = new Date().getTime();
    var testRequestID = 1;
    var incomingSeqNum = options.incomingSeqNum || 1;
    var outgoingSeqNum = options.outgoingSeqNum || 1;
    var isResendRequested = false;
    var isLogoutRequested = false;
    
    var self = this;

    
    //process incoming messages
    this.processIncomingMsg = function(fix){
        self.timeOfLastIncoming = new Date().getTime();
        _.each(self.stateListener, function(listener){
            listener({timeOfLastIncoming:self.timeOfLastIncoming});
        });
        //self.stateListener({timeOfLastIncoming:self.timeOfLastIncoming});
        

        //If not logged in
        if (self.isLoggedIn === false){
            //==if no message type, can't continue, fail
            if(!_.has(fix,35)){
                var errorMsg = '[FATAL] Message contains no tag 35, unable to continue:' + JSON.stringify(fix);
                util.error(errorMsg);
                self.sendError("FATAL",errorMsg);
                return;
            }
            
            var msgType = fix['35'];
            
            //==Confirm first msg is logon==
            if (msgType !== 'A') {
                var errorMsg = '[FATAL] First message must be logon:' + JSON.stringify(fix);
                util.error(errorMsg);
                self.sendError("FATAL",errorMsg);
                return;
            }
            else{ //log on message
                var heartbeatInMilliSeconds = defaultHeartbeatSeconds;
                if(!_.has(fix,108)){
                    var errorMsg = '[ERROR] Heartbeat message missing from logon, will use default:' + JSON.stringify(fix);
                    util.error(errorMsg);
                    self.sendError("ERROR",errorMsg);
                    return;
                }
                else{
                    var _heartbeatInMilliSeconds = fix[108] ;
                    heartbeatInMilliSeconds = parseInt(_heartbeatInMilliSeconds, 10) * 1000;                    
                }
                
                //==Set heartbeat mechanism
                self.heartbeatIntervalID = setInterval(function () {
                    var currentTime = new Date().getTime();
                    
                    //console.log("DEBUG:"+(currentTime-self.timeOfLastOutgoing)+">"+heartbeatInMilliSeconds);   
    
                    //==send heartbeats
                    if (currentTime - self.timeOfLastOutgoing > heartbeatInMilliSeconds && self.shouldSendHeartbeats) {
                        self.sendMsg({
                                '35': '0'
                            }); //heartbeat
                    }
    
                    //==ask counter party to wake up
                    if (currentTime - self.timeOfLastIncoming > (heartbeatInMilliSeconds * 1.5)&& self.shouldExpectHeartbeats) {
                        _.each(self.stateListener, function(listener){
                            listener({testRequestID:self.testRequestID});
                        });
                        //self.stateListener({testRequestID:self.testRequestID});
                        self.sendMsg({
                                '35': '1',
                                '112': self.testRequestID++
                            }); //test req id
                    }
    
                    //==counter party might be dead, kill connection
                    if (currentTime - self.timeOfLastIncoming > heartbeatInMilliSeconds * 2 && self.shouldExpectHeartbeats) {
                        var error = '[FATAL] No heartbeat from counter party in milliseconds ' + heartbeatInMilliSeconds * 1.5;
                        //util.debug("Interval ID:"+JSON.stringify(self.heartbeatIntervalID));
                        util.log(error);
                        self.sendError("FATAL",error);
                        return;
                    }
    
                }, heartbeatInMilliSeconds / 2); //End Set heartbeat mechanism==
                
                if(self.shouldRespondToLogon){
                    self.sendMsg({35:"A", 108:fix[108]}); //logon response
                }
                
                //==Logon successful
                self.isLoggedIn = true;
                _.each(self.stateListener, function(listener){
                    listener({isLoggedIn:self.isLoggedIn});
                });
                //self.stateListener({isLoggedIn:self.isLoggedIn});
                
            }
        }
        
        
        //store msg to datastore
        self.datastore.add(fix);
        
        //==Confirm message contains required fields (mainly seqno, time, etc.)
        if(!_.has(fix,34) || !_.has(fix,35) || !_.has(fix,49) || !_.has(fix,56) || !_.has(fix,52) ){
            var errorMsg = '[WARN] Message does not contain one of required tags:34,35,49,56,52';
            util.error(errorMsg+":"+JSON.stringify(fix));
            self.sendMsg({45:fix[34], 58:errorMsg});
            self.sendError("WARN",errorMsg);
            return;
        }
        var msgType = fix['35'];
        
        //==Process seq-reset (no gap-fill)
        if (msgType === '4' && _.isUndefined(fix['123']) || fix['123'] === 'N') {
            var resetseqnostr = fix['36'];//TODO what if 36 isn't available
            var resetseqno = parseInt(resetseqno, 10);
            if (resetseqno >= self.incomingSeqNum) {
                self.incomingSeqNum = resetseqno
                _.each(self.stateListener, function(listener){
                    listener({incomingSeqNum:self.incomingSeqNum});
                });
                //self.stateListener({incomingSeqNum:self.incomingSeqNum});
            } else {
                var error = '[FATAL] Seq-reset may not decrement sequence numbers: ' + JSON.stringify(fix);
                util.log(error);
                self.sendError("FATAL",error);
                return;
            }
        }
        
        //==Check sequence numbers
        var msgSeqNumStr = fix['34'];
        var msgSeqNum = parseInt(msgSeqNumStr, 10);
        
        //==expected sequence number
        if (msgSeqNum === self.incomingSeqNum) {
            self.incomingSeqNum++;
            self.isResendRequested = false;
            _.each(self.stateListener, function(listener){
                listener({incomingSeqNum:self.incomingSeqNum, isResendRequested:self.isResendRequested});
            });
            //self.stateListener({incomingSeqNum:self.incomingSeqNum, isResendRequested:self.isResendRequested});
        }
        //less than expected
        else if (msgSeqNum < self.incomingSeqNum) {
            //ignore posdup
            if (fix['43'] === 'Y') {
                return;//TODO handle this
            }
            //if not posdup, error
            else {
                var error = '[ERROR] Incoming sequence number ('+msgSeqNum+') lower than expected (' + self.incomingSeqNum+ ') : ' + JSON.stringify(fix);
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
                _.each(self.stateListener, function(listener){
                    listener({isResendRequested:self.isResendRequested});
                });
                //self.stateListener({isResendRequested:self.isResendRequested});
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
                _.each(self.stateListener, function(listener){
                    listener({incomingSeqNum:self.incomingSeqNum});
                });
                //self.stateListener({incomingSeqNum:self.incomingSeqNum});
            } else {
                var error = '[FATAL] Seq-reset may not decrement sequence numbers: ' + JSON.stringify(fix);
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
        //TODO isLogoutRequested is never modified!
        if (msgType === '5') {
            if (self.isLogoutRequested) {
                self.endSession();
            } else {
                self.sendMsg(fix);
            }
        }
        
        
        //pass message on to listener
        _.each(self.msgListener, function(listener){
            listener(prefil);
        });
        //self.msgListener(fix);
    }
    
    //callback listeners
    this.stateListener = [];
    this.msgListener = [];
    this.outMsgListener = [];
    this.endSessionListener = [];
    //this may only be access by method sendError(type, msg)
    this.errorListener = [];
    
    
    //callback subscription methods
    this.onMsg = function(callback){ self.msgListener.push(callback); }
    this.onOutMsg = function(callback){ self.outMsgListener.push(callback); }
    this.onError = function(callback){ self.errorListener.push(callback); }
    this.onStateChange = function(callback){ self.stateListener.push(callback); }
    this.onEndSession = function(callback){ self.endSessionListener.push(callback); }
    
    //public methods
    this.sendError = function(type, msg){
        _.each(self.errorListener, function(listener){
            listener(type,msg);
        });
        _.each(self.endSessionListener, function(listener){
            listener();
        });
        //self.errorListener(type,msg);
        //self.endSessionListener();
    }
    
    this.endSession = function(){
        //util.debug("End session Interval ID:"+JSON.stringify(self.heartbeatIntervalID));
        clearInterval(self.heartbeatIntervalID);
        _.each(self.endSessionListener, function(listener){
            listener();
        });
        //self.endSessionListener();
    }
    
    this.sendMsg = function(msg){
        var fix = _.clone(msg);
        
        self.timeOfLastOutgoing = new Date().getTime();
        var prefil = {8:self.fixVersion, 49:self.senderCompID, 56:self.targetCompID, 34:(self.outgoingSeqNum++).toString(), 52: new Date().getTime() };
        
        _.extend(prefil,fix);
        _.each(self.stateListener, function(listener){
            listener({timeOfLastOutgoing:self.timeOfLastOutgoing, outgoingSeqNum:self.outgoingSeqNum});
        });
        _.each(self.outMsgListener, function(listener){
            listener(prefil);
        });
        //self.stateListener({timeOfLastOutgoing:self.timeOfLastOutgoing, outgoingSeqNum:self.outgoingSeqNum});
        //self.outMsgListener(prefil);
    }
    
    this.sendLogon = function(){
        var msg = { 35:"A" };
        self.sendMsg(msg);
    }
    
}