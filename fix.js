#!/usr/bin/env node

"use strict";

var util = require('util');
var net = require('net');
var fixutils = require('./fixutils.js');
var framedecoder = require('./FIXFrameDecoder');
var _ = require('./deps/underscore-min.js');


exports.FIXServer = FIXServer;
exports.FIXClient = FIXClient;
exports.FIXSession = FIXSession;

/*==================================================*/
/*====================FIXServer====================*/
/*==================================================*/
function FIXServer(compID, options){
        var self = this;

        var servers = {};
        var server = net.createServer(function(socket){
            //connected
            var frameDecoder = new framedecoder.FixFrameDecoder();
            var fixSession = null;
            var perserverself = this;
            
            socket.on('data',function(data){
                frameDecoder.onMsg(function(msg){
                    if(perserverself.fixSession === null){
                        var fixVersion = msg[8];
                        var senderCompID = msg[49];
                        var targetCompID = msg[52];
                        
                        servers[perserverself.fixSession.getID()] = perserverself.fixSession;
                        perserverself.fixSession = new FIXSession(fixVersion, senderCompID, targetCompID, options);
                        
                        //TODOs
                        //session.onMsg(msg) -> server.onMsg(sender,target,msg)
                        perserverself.fixSession.onMsg(function(msg){
                            _.each(self.msgListener, function(listener){
                                listener(perserverself.session.getID(), msg);
                            });
                        });
                        
                        perserverself.fixSession.onError(function(msg){
                            _.each(self.errorListener, function(listener){
                                listener(perserverself.fixSession.getID(), msg);
                            });
                        });
                    }
                    
                    perserverself.fixSession.processIncomingMsg(msg);
                });
                
                frameDecoder.onError(function(msg){
                    _.each(self.errorListener, function(listener){
                        if(perserverself.fixSession === null || _.isUndefined(perserverself.fixSession)){
                            listener("UNKNOWN", msg);
                            socket.end();
                        }
                        else{
                            listener(perserverself.fixSession.getID(), msg);
                        }
                    });
                });
                
                frameDecoder.processData(data);
            });
            
            socket.on('end', function(){
                if(!_.isUndefined(perserverself.fixSession)){
                    delete servers[perserverself.fixSession.getID()];
                    perserverself.fixSession.modifyBehavior({shouldSendHeartbeats:false, shouldExpectHeartbeats:false});
                }
            });
        });
        
        this.msgListener = [];
        this.onMsg = function(callback){ self.msgListener.push(callback);}
        
        this.errorListener = [];
        this.onError = function(callback){ self.errorListener.push(callback);}
        
        this.listen = function(){
            server.listen.apply(server,arguments);
            //server.listen(arguments);
        };
}

/*==================================================*/
/*====================FIXClient====================*/
/*==================================================*/
function FIXClient(fixVersion, senderCompID, targetCompID, options){
    
    var self = this;
    var socket = null;
    var session = new FIXSession(fixVersion, senderCompID, targetCompID, options);
    
    /*******Public*******/
    
    //[PUBLIC] get unique ID of this session
    this.getID = function(){
        var serverName = fixVersion+"-"+senderCompID+"-"+targetCompID;
        return serverName;
    }
    
    //callback subscription methods
    //[PUBLIC] listen to incoming messages (user apps subscribe here)
    //arguments: json object
    this.onMsg = function(callback){ session.onMsg(callback); }
    
    //[PUBLIC] listen to outgoing messages (only used by admin apps)
    //arguments: json object
    this.onOutMsg = function(callback){ session.onOutMsg(callback); }
    
    //[PUBLIC] listen to error messages
    //arguments: type -- (FATAL, ERROR, etc.) -- fatal means session is gone
    //arguments: description -- text description
    this.onError = function(callback){ session.onError(callback); }
    
    //[PUBLIC] listen to state changes (only used by admin apps)
    //arguments: json object -- example: {loggedIn:true}
    this.onStateChange = function(callback){ session.onStateChange(callback); }

    //[PUBLIC] listen to end of session alerts (only used by system apps)
    //  for example, tcp connector uses this to find out when to disconnect
    this.onEndSession = function(callback){ session.onEndSession(callback); }
    
    //[PUBLIC] Sends FIX json to counter party
    this.sendMsg = function(msg){ session.sendMsg(msg); }
    
    //[PUBLIC] Sends logon FIX json to counter party
    this.sendLogon = function(){ session.sendLogon(); }
    
    //[PUBLIC] Sends logoff FIX json to counter party
    this.sendLogoff = function(){ session.sendLogoff(); }
    
    //[PUBLIC] Modify's one or more 'behabior' control variables.
    //  Neverever used outside of testing
    this.modifyBehavior = function(data){ session.modifyBehavior(data); }

    
    this.createConnection = function(options, listener){
        self.socket = net.createConnection(options,function(){
            
            //client connected, create fix session
            var fixFrameDecoder = new framedecoder.FixFrameDecoder();

            session.onOutMsg(function(msg){
                var outstr = fixutils.convertMapToFIX(msg);
                self.socket.write(outstr);
                
            });
            session.onEndSession(function(){
                self.socket.end();
            });

            self.socket.on('connect', function(){
                util.debug("connected");
            });
            
            self.socket.on('data',function(data){
                //TODO, convert to FIX
                fixFrameDecoder.onMsg(function(data){
                    session.processIncomingMsg(data);
                });
                fixFrameDecoder.processData(data);
                fixFrameDecoder.onError(function(type, error){
                });
            });
            
            self.socket.on('end',function(data){
               session.modifyBehavior({shouldSendHeartbeats:false, shouldExpectHeartbeats:false});
            });
            
            //pass on this session to client
            listener(self);
            
        });
    }
}

/*==================================================*/
/*====================FIXSession====================*/
/*==================================================*/
function FIXSession (fixVersion, senderCompID, targetCompID, options){

    /*******Public*******/
    
    //required when session needs to be identified by wrappers
    this.fixVersion = fixVersion;
    this.senderCompID = senderCompID;
    this.targetCompID = targetCompID;
    this.options = _.defaults(options,{shouldSendHeartbeats:true,
                              shouldExpectHeartbeats:true,
                              shouldRespondToLogon:true,
                              defaultHeartbeatSeconds:30,
                              incomingSeqNum:1,
                              outgoingSeqNum:1,
                              isDuplicateFunc:function(){return false},
                              isAuthenticFunc:function(){return true},
                              datastore:new function () {
                                    var dataarray = [];
                                    this.add = function(data){dataarray.push(data);};
                                    this.each = function(func){_.each(dataarray,func);};
                                },
                              });
    
    //[PUBLIC] get unique ID of this session
    this.getID = function(){
        var serverName = fixVersion+"-"+senderCompID+"-"+targetCompID;
        return serverName;
    }
    
    //callback subscription methods
    //[PUBLIC] listen to incoming messages (user apps subscribe here)
    //arguments: json object
    this.onMsg = function(callback){ self.msgListener.push(callback); }
    
    //[PUBLIC] listen to outgoing messages (only used by admin apps)
    //arguments: json object
    this.onOutMsg = function(callback){ self.outMsgListener.push(callback); }
    
    //[PUBLIC] listen to error messages
    //arguments: type -- (FATAL, ERROR, etc.) -- fatal means session is gone
    //arguments: description -- text description
    this.onError = function(callback){ self.errorListener.push(callback); }
    
    //[PUBLIC] listen to state changes (only used by admin apps)
    //arguments: json object -- example: {loggedIn:true}
    this.onStateChange = function(callback){ self.stateListener.push(callback); }

    //[PUBLIC] listen to end of session alerts (only used by system apps)
    //  for example, tcp connector uses this to find out when to disconnect
    this.onEndSession = function(callback){ self.endSessionListener.push(callback); }
    
    //non-callback methods

    //[PUBLIC] Sends FIX json to counter party
    this.sendMsg = function(msg){
        var fix = _.clone(msg);
        
        options.timeOfLastOutgoing = new Date().getTime();
        var seqn = options.outgoingSeqNum++;
        var prefil = {8:fixVersion, 49:senderCompID, 56:targetCompID, 34:seqn, 52: new Date().getTime() };
        
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
    
    //[PUBLIC] Sends logon FIX json to counter party
    this.sendLogon = function(){
        var msg = { 35:"A" };
        self.sendMsg(msg);
    }

    //[PUBLIC] Sends logoff FIX json to counter party
    this.sendLogoff = function(){
        var msg = { 35:"5" };
        options.isLogoutRequested = true;
        self.sendMsg(msg);
    }
    
    //[PUBLIC] Modify's one or more 'behabior' control variables.
    //  Neverever used outside of testing
    this.modifyBehavior = function(data){
        for(var idx in data){
            if(idx === "shouldSendHeartbeats"){
                this.shouldSendHeartbeats = data[idx];
            }
            else if(idx === "shouldExpectHeartbeats"){
                this.shouldExpectHeartbeats = data[idx];
            }
            else if(idx === "shouldRespondToLogon"){
                this.shouldRespondToLogon = data[idx];
            }
        }
        
        if(options.shouldSendHeartbeats === false && options.shouldExpectHeartbeats === false){
            clearInterval(self.heartbeatIntervalID);
        }
        
        _.each(self.stateListener, function(listener){
            listener(data);
        });
    }


    
    var self = this;

    
    //[PUBLIC] process incoming messages
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
                    if (currentTime - self.timeOfLastOutgoing > heartbeatInMilliSeconds && options.shouldSendHeartbeats) {
                        self.sendMsg({
                                '35': '0'
                            }); //heartbeat
                    }
    
                    //==ask counter party to wake up
                    if (currentTime - self.timeOfLastIncoming > (heartbeatInMilliSeconds * 1.5)&& options.shouldExpectHeartbeats) {
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
                    if (currentTime - self.timeOfLastIncoming > heartbeatInMilliSeconds * 2 && options.shouldExpectHeartbeats) {
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
        options.datastore.add(fix);
        
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
            if (resetseqno >= options.incomingSeqNum) {
                options.incomingSeqNum = resetseqno
                _.each(self.stateListener, function(listener){
                    listener({incomingSeqNum:options.incomingSeqNum});
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
        if (msgSeqNum === options.incomingSeqNum) {
            options.incomingSeqNum++;
            self.isResendRequested = false;
            _.each(self.stateListener, function(listener){
                listener({incomingSeqNum:options.incomingSeqNum, isResendRequested:self.isResendRequested});
            });
            //self.stateListener({incomingSeqNum:self.incomingSeqNum, isResendRequested:self.isResendRequested});
        }
        //less than expected
        else if (msgSeqNum < options.incomingSeqNum) {
            //ignore posdup
            if (fix['43'] === 'Y') {
                return;//TODO handle this
            }
            //if not posdup, error
            else {
                var error = '[ERROR] Incoming sequence number ('+msgSeqNum+') lower than expected (' + options.incomingSeqNum+ ') : ' + JSON.stringify(fix);
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
                options.datastore.each(function(json){
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

            if (newSeqNo >= options.incomingSeqNum) {
                options.incomingSeqNum = newSeqNo;
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
            options.datastore.each(function(json){
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
    
    
    /*******Private*******/
    
    //behavior control variables
    //var shouldSendHeartbeats = _.isUndefined(options.shouldSendHeartbeats) || true;
    //var shouldExpectHeartbeats = _.isUndefined(options.shouldExpectHeartbeats) || true;
    //var shouldRespondToLogon = _.isUndefined(options.shouldRespondToLogon) || true;

    //options
    //var defaultHeartbeatSeconds = _.isUndefined(options.defaultHeartbeatSeconds) || 30 ;
    //this.isDuplicateFunc = _.isUndefined(options.isDuplicateFunc) || function () {return false;} ;
    //this.isAuthenticFunc = _.isUndefined(options.isAuthenticFunc) || function () {return true;} ;
    /*this.datastore = _.isUndefined(options.datastore) || new function () {
        var dataarray = [];
        this.add = function(data){dataarray.push(data);};
        this.each = function(func){_.each(dataarray,func);};
    } ;*/


    //transient variable (nothing to do with state)
    this.heartbeatIntervalID = "";

    //runtime variables 
    var isLoggedIn = false;
    var timeOfLastIncoming = new Date().getTime();
    var timeOfLastOutgoing = new Date().getTime();
    var testRequestID = 1;
    //var incomingSeqNum = _.isUndefined(options.incomingSeqNum) || 1;
    //var outgoingSeqNum = _.isUndefined(options.outgoingSeqNum) || 1;
    var isResendRequested = false;
    var isLogoutRequested = false;

    
    //callback listeners
    this.stateListener = [];
    this.msgListener = [];
    this.outMsgListener = [];
    this.endSessionListener = [];
    //this may only be access by method sendError(type, msg)
    this.errorListener = [];
    
    
    //internal methods (non-public)
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
    
    //endSession calls methods provided by code which wraps FixSession. It exists so the
    //network code can supply a way to drop connection, without introducing network
    //code to this class
    this.endSession = function(){
        //util.debug("End session Interval ID:"+JSON.stringify(self.heartbeatIntervalID));
        clearInterval(self.heartbeatIntervalID);
        _.each(self.endSessionListener, function(listener){
            listener();
        });
        //self.endSessionListener();
    }
    

    
    
    
}