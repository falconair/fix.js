#!/usr/bin/env node

"use strict";

var util = require('util');
var net = require('net');
var events = require('events');
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
            
            frameDecoder.on('msg',function(msgtxt){
                var msg = fixutils.convertToMap(msgtxt);

                if(_.isUndefined(perserverself.fixSession )){
                    var fixVersion = msg[8];
                    var senderCompID = msg[49];
                    var targetCompID = msg[56];

                    var extendedOptions = _.extend(options,{shouldRespondToLogon:true});
                    perserverself.fixSession = new FIXSession(fixVersion, senderCompID, targetCompID, extendedOptions);
                    var serverid = perserverself.fixSession.getID();
                    servers[serverid ] = perserverself.fixSession;
                    
                    perserverself.fixSession.on('msg',function(msg){ self.emit('msg',serverid, msg); });
                    perserverself.fixSession.on('state',function(msg){ self.emit('state',serverid ,msg); });
                    perserverself.fixSession.on('error',function(type,msg){ self.emit('error',serverid ,type,msg); });
                    
                    perserverself.fixSession.on('outmsg',function(msg){
                        var outstr = fixutils.convertMapToFIX(msg);
                        socket.write(outstr);
                        self.emit('outmsg',serverid ,msg);
                    });
                    
                }
                
                perserverself.fixSession.processIncomingMsg(msg);
            });
            
            frameDecoder.on('error',function(type, msg){
                if(perserverself.fixSession === null || _.isUndefined(perserverself.fixSession)){
                    self.emit('error','UNKNOWN',type,msg);
                }
                else{
                    self.emit('error',serverid,type,msg);
                }
                if(type === 'FATAL'){
                    socket.end();
                }
            });
            
            socket.on('data',function(data){
                
                frameDecoder.processData(data);
            });
            
            socket.on('end', function(){
                if(!_.isUndefined(perserverself.fixSession)){
                    delete servers[perserverself.fixSession.getID()];
                    perserverself.fixSession.modifyBehavior({shouldSendHeartbeats:false, shouldExpectHeartbeats:false});
                }
            });
        });
        
        
        this.listen = function(){
            server.listen.apply(server,arguments);
            //server.listen(arguments);
        };
}
util.inherits(FIXServer, events.EventEmitter);

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
    //this.onMsg = function(callback){ session.onMsg(callback); }
    
    //[PUBLIC] listen to outgoing messages (only used by admin apps)
    //arguments: json object
    //this.onOutMsg = function(callback){ session.onOutMsg(callback); }
    
    //[PUBLIC] listen to error messages
    //arguments: type -- (FATAL, ERROR, etc.) -- fatal means session is gone
    //arguments: description -- text description
    //this.onError = function(callback){ session.onError(callback); }
    
    //[PUBLIC] listen to state changes (only used by admin apps)
    //arguments: json object -- example: {loggedIn:true}
    //this.onStateChange = function(callback){ session.onStateChange(callback); }

    //[PUBLIC] listen to end of session alerts (only used by system apps)
    //  for example, tcp connector uses this to find out when to disconnect
    //this.onEndSession = function(callback){ session.onEndSession(callback); }
    
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
            fixFrameDecoder.on('msg',function(datatxt){
                var data = fixutils.convertToMap(datatxt);
                session.processIncomingMsg(data);
            });
            fixFrameDecoder.on('error',function(type, error){
                //TODO handle
            });

            //TODO users of clients need to subscribe to outgoing/incoming msgs, error, etc.
            session.on('outmsg',function(msg){
                var outstr = fixutils.convertMapToFIX(msg);
                self.socket.write(outstr);
                self.emit('outmsg',msg);
            });
            session.on('endsession',function(){
                self.socket.end();
                self.emit('endsession');
            });
            session.on('msg',function(msg){
                self.emit('msg',msg);
            });

            self.socket.on('connect', function(){
                self.emit('connect');
            });
            
            self.socket.on('data',function(data){
                fixFrameDecoder.processData(data);
            });
            
            self.socket.on('end',function(data){
               session.modifyBehavior({shouldSendHeartbeats:false, shouldExpectHeartbeats:false});
            });
            
            //pass on this session to client
            listener(self);
            
        });
    }
}
util.inherits(FIXClient, events.EventEmitter);

/*==================================================*/
/*====================FIXSession====================*/
/*==================================================*/
function FIXSession (fixVersion, senderCompID, targetCompID, options){
    var self = this;

    /*******Public*******/
    
    //=======EVENTS=========//
    //msg   :- ...on('msg', jsonobject) [listen to incoming messages (user apps subscribe here)]
    //state :- ...on('state',jsonobject) [listen to state changes (only used by admin apps)]
    //outmsg:- ...on('outmsg',jsonobject) [listen to outgoing messages (only used by admin apps)]
    //error :- ...on('error',type,jsonobject) [listen to error messages, type=FATAL means connection is gone]
    //endsession :- ...on('endsession') [listen to end of session alerts (only used by system apps)]
    
    //required when session needs to be identified by wrappers
    this.fixVersion = fixVersion;
    this.senderCompID = senderCompID;
    this.targetCompID = targetCompID;
    this.options = _.defaults(options,{shouldSendHeartbeats:true,
                              shouldExpectHeartbeats:true,
                              shouldRespondToLogon:false,
                              defaultHeartbeatSeconds:30,
                              incomingSeqNum:1,
                              outgoingSeqNum:1,
                              isDuplicateFunc:{confirm:function(){return false}},
                              isAuthenticFunc:{confirm:function(){return true}},
                              datastore:new function () {
                                    var dataarray = [];
                                    this.add = function(data){dataarray.push(data);};
                                    this.each = function(func){_.each(dataarray,func);};
                                },
                              });

    
    //[PUBLIC] get unique ID of this session
    this.getID = function(){
        var serverName = self.fixVersion+"-"+self.senderCompID+"-"+self.targetCompID;
        return serverName;
    }
    
    
    //non-callback methods

    //[PUBLIC] Sends FIX json to counter party
    this.sendMsg = function(msg){
        var fix = _.clone(msg);
        
        options.timeOfLastOutgoing = new Date().getTime();
        var seqn = options.outgoingSeqNum++;
        var prefil = {8:fixVersion, 49:senderCompID, 56:targetCompID, 34:seqn, 52: new Date().getTime() };
        
        _.extend(prefil,fix);
        self.emit('state', {timeOfLastOutgoing:self.timeOfLastOutgoing, outgoingSeqNum:self.outgoingSeqNum});
        self.emit('outmsg',prefil);
    }
    
    //[PUBLIC] Sends logon FIX json to counter party
    this.sendLogon = function(){
        var msg = { 35:"A", 108:20 };
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
        
        self.emit('state', data);
    }

    
    //[PUBLIC] process incoming messages
    this.processIncomingMsg = function(fix){

        self.timeOfLastIncoming = new Date().getTime();
        self.emit('state', {timeOfLastIncoming:self.timeOfLastIncoming});
        

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
                var heartbeatInMilliSeconds = options.defaultHeartbeatSeconds;
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
                    
    
                    //==send heartbeats
                    if (currentTime - self.timeOfLastOutgoing > heartbeatInMilliSeconds && options.shouldSendHeartbeats) {
                        self.sendMsg({
                                '35': '0'
                            }); //heartbeat
                    }
    
                    //==ask counter party to wake up
                    if (currentTime - self.timeOfLastIncoming > (heartbeatInMilliSeconds * 1.5)&& options.shouldExpectHeartbeats) {
                        self.emit('state', {testRequestID:self.testRequestID});
                        self.sendMsg({
                                '35': '1',
                                '112': self.testRequestID++
                            }); //test req id
                    }
    
                    //==counter party might be dead, kill connection
                    if (currentTime - self.timeOfLastIncoming > heartbeatInMilliSeconds * 2 && options.shouldExpectHeartbeats) {
                        var error = '[FATAL] No heartbeat from counter party in milliseconds ' + heartbeatInMilliSeconds * 1.5;
                        util.log(error);
                        self.sendError("FATAL",error);
                        return;
                    }
    
                }, heartbeatInMilliSeconds / 2); //End Set heartbeat mechanism==
                
                if(options.shouldRespondToLogon === true){
                    self.sendMsg({35:"A", 108:fix[108]}); //logon response
                }
                
                //==Logon successful
                self.isLoggedIn = true;
                self.emit('state', {isLoggedIn:self.isLoggedIn});
                
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
                options.incomingSeqNum = resetseqno;
                self.emit('state',{incomingSeqNum:options.incomingSeqNum});
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
            self.emit('state', {incomingSeqNum:options.incomingSeqNum, isResendRequested:self.isResendRequested});
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
                self.emit('state',{isResendRequested:self.isResendRequested});
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
                self.emit('state',{incomingSeqNum:self.incomingSeqNum});
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
        self.emit('msg',fix);
    }
    
    

    //transient variable (nothing to do with state)
    this.heartbeatIntervalID = "";

    //runtime variables 
    this.isLoggedIn = false;
    this.timeOfLastIncoming = new Date().getTime();
    this.timeOfLastOutgoing = new Date().getTime();
    this.testRequestID = 1;
    this.isResendRequested = false;
    this.isLogoutRequested = false;
    
    
    //internal methods (non-public)
    this.sendError = function(type, msg){
        self.emit('error',type,msg);
        if(type === 'FATAL'){
            self.endSession();
        }
    }
    
    //endSession calls methods provided by code which wraps FixSession. It exists so the
    //network code can supply a way to drop connection, without introducing network
    //code to this class
    this.endSession = function(){
        clearInterval(self.heartbeatIntervalID);
        self.emit('endsession');
    }
}
util.inherits(FIXSession, events.EventEmitter);