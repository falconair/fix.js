import { DECODE_PROBLEM_CODES, type DecodeProblem, type DecodeProblemCode, type MessageObject } from '../wire/message.ts';

export type Role = 'initiator' | 'acceptor';

/** connected: TCP is up, no Logon yet. loggingOn: our Logon is out (initiator). */
export type Phase = 'connected' | 'loggingOn' | 'active' | 'loggingOut' | 'closed';

export interface EngineConfig {
  /** BeginString. */
  readonly version: string;
  /** Our CompID. */
  readonly sender: string;
  /** Their CompID. */
  readonly target: string;
  readonly role: Role;
  /** Heartbeat interval in seconds: what an initiator proposes; an acceptor uses the counterparty's. */
  readonly heartbeat: number;
  /** Nothing automatic: no Logon, heartbeats, replies, validation or timeouts. Headers are still filled. */
  readonly manual: boolean;
  /** Extra fields for our Logon (Username, Password, ResetSeqNumFlag). */
  readonly logon: Readonly<Record<string, unknown>>;
  /** Seconds to wait for a Logon reply, and for a Logout reply. Checked on a once-a-second tick, so they can fire up to 1 s late. */
  readonly logonTimeout: number;
  readonly logoutTimeout: number;
  /** Largest accepted difference between a message's SendingTime and our clock, in seconds. */
  readonly maxClockSkew: number;
}

export interface EngineOptions {
  readonly version: string;
  readonly sender: string;
  readonly target: string;
  readonly role: Role;
  readonly heartbeat?: number;
  readonly manual?: boolean;
  readonly logon?: Readonly<Record<string, unknown>>;
  readonly logonTimeout?: number;
  readonly logoutTimeout?: number;
  readonly maxClockSkew?: number;
}

/** A complete configuration: 30 s heartbeat, 10 s logon/logout timeouts, 120 s clock skew. */
export function engineConfig(options: EngineOptions): EngineConfig {
  return {
    version: options.version,
    sender: options.sender,
    target: options.target,
    role: options.role,
    heartbeat: options.heartbeat ?? 30,
    manual: options.manual ?? false,
    logon: options.logon ?? {},
    logonTimeout: options.logonTimeout ?? 10,
    logoutTimeout: options.logoutTimeout ?? 10,
    maxClockSkew: options.maxClockSkew ?? 120,
  };
}

export interface EngineState {
  readonly phase: Phase;
  /** Next MsgSeqNum we send. */
  readonly next: number;
  /** Next MsgSeqNum we expect. */
  readonly expected: number;
  /** Negotiated heartbeat interval, seconds. */
  readonly heartbeat: number;
  /** When we last sent / received anything (ms). */
  readonly lastSent: number;
  readonly lastReceived: number;
  /** When the current phase began (for logon/logout timeouts). */
  readonly phaseSince: number;
  /** Our unanswered TestRequest, if any. */
  readonly testRequest: { readonly id: string; readonly sentAt: number } | undefined;
  /** How many TestRequests we have sent (their TestReqIDs are TEST-1, TEST-2, …). */
  readonly testRequests: number;
  /** A resend is outstanding for everything up to this MsgSeqNum. */
  readonly recovering: number | undefined;
  /** When we last sent a ResendRequest (ms), while recovering. */
  readonly resendRequestedAt: number | undefined;
  /** How many ResendRequests we have sent for the current recovery (0 when not recovering). */
  readonly resendAttempts: number;
  /**
   * We sent a Logon with ResetSeqNumFlag=Y on a logged-on session, and neither its reply nor their MsgSeqNum 1 of the
   * new sequence (sent new, not resent) has come yet: another reset of ours is refused until one does.
   */
  readonly resetSent: boolean;
  /**
   * How many resets of ours have had no Logon in reply: every reset we start is owed one reset Logon from them.
   * Only a reset Logon brings it down: whatever else ended the wait above, a reset Logon that arrives while one
   * is owed is that reply, and is not answered. Any other reset Logon is a request, and is answered.
   */
  readonly resetRepliesOwed: number;
  /**
   * Under FIXT.1.1, the application version our Logons name (DefaultApplVerID): an initiator's is the
   * one its first Logon named, however written (FIX 5.0 SP2 when it wrote none), an acceptor's the one
   * the counterparty's Logon named. Undefined until then, when the first Logon wrote the field as
   * null, and in every other version.
   */
  readonly applVerID: string | undefined;
}

export type EngineEvent =
  | { readonly type: 'start' }
  /**
   * `arrived`: when the last of the message's bytes arrived (ms), for a message processed later
   * than that. Its SendingTime is judged against this: a message that waited to be processed is
   * no older for it. Without it, the time of the step is when it arrived.
   */
  | { readonly type: 'received'; readonly message: MessageObject; readonly problems: readonly DecodeProblem[]; readonly arrived?: number }
  | { readonly type: 'garbled'; readonly error: string }
  | { readonly type: 'send'; readonly msgType: string; readonly fields: Readonly<Record<string, unknown>> }
  | { readonly type: 'logout'; readonly text?: string }
  | { readonly type: 'setSeqNums'; readonly next?: number; readonly expected?: number }
  | { readonly type: 'tick' }
  /**
   * The counterparty is known to be alive, or cannot be known to be silent, though nothing of it
   * was processed: bytes of it are held and not yet taken in, or the session itself had stopped
   * reading. Silence is counted from here, and a TestRequest still unanswered is forgotten: its
   * answer may be among what has not been read. So may the answer to a ResendRequest: the wait
   * before it is asked for again is counted from here too, and the requests made still count.
   */
  | { readonly type: 'heard' }
  | { readonly type: 'disconnected' };

/** Problem.code's own names; DECODE_PROBLEM_CODES adds the rest (see PROBLEM_CODES). */
const OWN_PROBLEM_CODES = [
  'Garbled', 'NotLoggedOn', 'UnexpectedLogon', 'BeginStringMismatch', 'CompIDMismatch',
  'SendingTimeAccuracy', 'MissingMsgSeqNum', 'SeqNumTooLow', 'SeqNumGap',
  'HeartbeatTimeout', 'LogonTimeout', 'LogoutTimeout', 'LogonRejected', 'InvalidUnsupportedAppVersion',
  // Raised by the transport before a session exists (server.watch).
  'LogonRefused', 'ConnectionLimit', 'MessageTooLarge', 'TLSMismatch',
] as const;

/**
 * Every name Problem.code can hold. A runtime list, so entryFromJSON()
 * (transport/json.ts) can check a code against it without a second,
 * hand-written list that could drift from this one.
 */
export const PROBLEM_CODES: readonly string[] = [...OWN_PROBLEM_CODES, ...DECODE_PROBLEM_CODES];

export type ProblemCode = typeof OWN_PROBLEM_CODES[number] | DecodeProblemCode;

/** Every name Problem.action can hold; see PROBLEM_CODES for why this is a runtime list. */
export const PROBLEM_ACTIONS = ['Ignored', 'Rejected', 'ResendRequested', 'LoggedOut', 'Disconnected'] as const;

export interface Problem {
  readonly code: ProblemCode;
  readonly text: string;
  /** What the session did about it. */
  readonly action: typeof PROBLEM_ACTIONS[number];
  /** MsgSeqNum of the message concerned, when there is one. */
  readonly refSeqNum?: number;
}

export type Action =
  /** Encode and send. The session header is already filled. */
  | { readonly type: 'send'; readonly msgType: string; readonly fields: Readonly<Record<string, unknown>> }
  /** Replay what we sent with these MsgSeqNums (see resendPlan). */
  | { readonly type: 'resend'; readonly from: number; readonly to: number }
  /** Hand a received message to the application (session messages included). */
  | { readonly type: 'deliver'; readonly message: MessageObject }
  /** The session is now logged on. */
  | { readonly type: 'active' }
  /** Both sequence numbers start again from 1 (ResetSeqNumFlag): what is recorded from here on begins a new epoch. */
  | { readonly type: 'reset' }
  /** Record in the session history. */
  | { readonly type: 'problem'; readonly problem: Problem }
  /** Close the connection. */
  | { readonly type: 'disconnect'; readonly by: 'us' | 'them'; readonly text: string };

export interface Step {
  readonly state: EngineState;
  readonly actions: readonly Action[];
}
