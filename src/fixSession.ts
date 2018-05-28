class FIXSession{
    readonly fixVersion:string;
    readonly senderCompID:string;
    readonly targetCompID:string;
    
    readonly shouldSendHeatbeats:boolean;
    readonly shouldExpectHeartbeats:boolean;
    readonly shouldRespondToLogon:boolean;

    readonly defaultHeartbeatSeconds:number;

    incomingSeqNum = 1;
    outgoingSeqNum = 1;

    //isdupfunc? isauthfunc?

    //datastore: IDataStore;

    //transiet variable (nothing to do with state)
    heartbeatIntervalID = "";

    //runtime variables
    private isLoggedIn = false;
    private timeOfLastIncoming = new Date().getTime();
    private timeOfLastOutgoing = new Date().getTime();
    private testRequestID = 1;
    private isResendRequested = false;
    private isLogoutRequested = false;
    //private store:IDataStore;

    constructor(fixVersion:string,
        senderCompID:string,
        targetCompID:string,
        shouldSendHeatbeats = true,
        shouldExpectHeartbeats = true,
        shouldRespondToLogon = true,
        defaultHeartbeatSeconds = 30,
        incomingSeqNum = 1,
        outgoingSeqNum = 1
    ){
        this.fixVersion = fixVersion;
        this.senderCompID = senderCompID;
        this.targetCompID = targetCompID;

        this.shouldSendHeatbeats = shouldSendHeatbeats;
        this.shouldExpectHeartbeats = shouldExpectHeartbeats;
        this.shouldRespondToLogon = shouldRespondToLogon;
        this.defaultHeartbeatSeconds = defaultHeartbeatSeconds;
        this.incomingSeqNum = incomingSeqNum;
        this.outgoingSeqNum = outgoingSeqNum;

        //this.store = datastore(this.getID())
    }

    public getID():string {
        var serverName = this.fixVersion + "-" + this.senderCompID + "-" + self.targetCompID;
        return serverName;
    }



}