// Where fix.js is known to differ from what QuickFIX/J's acceptance scripts
// expect: one ruling per script, each with its reason. The acceptance suite
// holds fix.js to this list both ways: a script not listed here must pass as
// written, and a listed script must differ exactly as its ruling says, so a
// ruling that no longer applies fails the suite as surely as a new difference.
// A script that stops early is not played beyond that line, so its ruling also
// names what the rest of the script would meet, and own-scripts.test.ts holds
// fix.js to each of those behaviours with scripts of our own.
// interop/README.md explains each reason.

export interface Difference {
  /** The script, as pins.ts names it: 'fix44/2m_BodyLengthValueNotCorrect.def'. */
  readonly script: string;
  /** Why fix.js differs: one reason, or several joined by '; '. */
  readonly reason: string;
  /** Tags whose values differ from the script's and are not compared. Each must differ somewhere in the script. */
  readonly ignore?: readonly number[];
  /** Tags fix.js sends in a message where the script's line has no such field. Each must be sent somewhere in the script. */
  readonly extra?: readonly number[];
  /** The line of the script at which fix.js stops matching it. Without this, the script runs to its end. */
  readonly failsAt?: number;
  /**
   * What comes at the `failsAt` line in place of the message expected there:
   * the MsgType of the message fix.js sends, as it is on the wire ('5' for a
   * Logout); 'nothing' when no message comes within the wait; or 'closed'
   * when the connection is closed instead. Given whenever `failsAt` is. More
   * than one where timing decides which of them it is.
   */
  readonly arrives?: readonly string[];
  /** The MsgType, as it is on the wire, of each message fix.js sends that the script never reads. */
  readonly unread?: readonly string[];
}

const TEXT = 'fix.js words its own Text (58): it names the field and says what is wrong with it';
const ECHO = 'the test application sends an order back decoded and encoded again, so a quantity written with leading zeros and decimals goes back as a plain number';
const TEST_REQ_ID = 'fix.js numbers its TestReqIDs (TEST-1, TEST-2, ...), so a reply can be told from a reply to an earlier one; QuickFIX/J always sends TEST';
const SAYS_WHY = 'before it closes a connection it refuses, fix.js sends a Logout saying why; QuickFIX/J only closes it';
const LOGOUT_TOO_LOW = "the script's Logout has a MsgSeqNum that is too low, which QuickFIX/J never checks on a Logout; fix.js answers any message that is too low with a Logout saying so, and disconnects";
const NOT_A_TAG = 'a field whose tag is not a number (a tag of -1, say) makes the message garbled, and fix.js ignores it; and it takes user-defined tags (5000 and up) without a dictionary';
const SYMBOL_OPTIONAL = "fix.js's FIX 4.4 dictionary is FIX Orchestra's, where Symbol (55) is optional in a NewOrderSingle; QuickFIX/J's requires it";
const NO_LOGOUT = 'after rejecting a resent message whose OrigSendingTime is later than its SendingTime, fix.js carries on; QuickFIX/J also logs out';
const NO_QUEUE = 'fix.js does not keep a message that arrives ahead of sequence: it asks for everything from the gap on (EndSeqNo=0) and takes it when it is resent; the script resends only the message that was missing';
const OWN_TRAFFIC = "what comes where the script expects a Reject is fix.js's own Heartbeat, or its TestRequest when its once-a-second timer puts that first";
const SEQ_NOT_USED = "a garbled message's MsgSeqNum is not used, so the script's next message comes ahead of sequence and gets a ResendRequest";
const RESYNC = 'after a message whose BodyLength is too large, fix.js looks for the next BeginString and so reads the message that follows, which is ahead of sequence and gets a ResendRequest; the script expects that message to be lost with the first';
const LOGOUT_TOO_HIGH = "the script's Logout has a MsgSeqNum that is too high, which QuickFIX/J never checks on a Logout; fix.js sends a ResendRequest for what it missed (unless it is waiting for a resend already), then its Logout in reply, and closes the connection at once, so the resend it asked for is never received";

const LAYERS = "fix.js reads a FIXT.1.1 session with one dictionary for both layers, so a field of the application layer on a session message is not defined for that message type (SessionRejectReason 2); QuickFIX/J reads session messages with the session layer's dictionary alone, to which the tag is no tag at all (0)";
const SESSION_ID_VALUES = "fix.js checks the values of a group's fields before its count: its FIX Latest dictionary gives TradingSessionID (336) a set of values, so it rejects a value that is neither among them nor in the range left open to agreement (100 and up), with SessionRejectReason 5; QuickFIX/J checks the count first (16), even with a dictionary that gives 336 values";
const FIX50_AS_SP2 = "fix.js reads FIX 5.0 with its FIX Latest dictionary, in which a SecurityDefinition no longer has TradingSessionID (336) among its own fields, so it rejects the script's; QuickFIX/J has a dictionary for FIX 5.0 itself";
const LOGON_LINE = "the script's expected Logon lacks DefaultApplVerID (1137), which a FIXT.1.1 Logon must carry; QuickFIX/J's own run does not compare the fields of a Logon";

const FIX4 = ['fix42', 'fix44'];
const FIXT = ['fix50', 'fixLatest'];
const scripts = (folders: readonly string[], ...names: string[]): string[] => names.flatMap(name => folders.map(folder => `${folder}/${name}.def`));
/** These scripts in every folder: FIX 4.2, FIX 4.4, and the two that speak FIXT.1.1 (FIX 5.0 and FIX Latest). */
const every = (...names: string[]): string[] => scripts([...FIX4, ...FIXT], ...names);
const fix4 = (...names: string[]): string[] => scripts(FIX4, ...names);
const fixt = (...names: string[]): string[] => scripts(FIXT, ...names);
const rule = (scripts: readonly string[], ruling: Omit<Difference, 'script'>): Difference[] => scripts.map(script => ({ script, ...ruling }));

export const DIFFERENCES: readonly Difference[] = [
  ...rule([
    ...every(
      '11c_NewSeqNoLess', '14c_TagNotDefinedForMsgType', '14d_TagSpecifiedWithoutValue', '14f_IncorrectDataFormat',
      '14g_HeaderBodyTrailerFieldsOutOfOrder', '14h_RepeatedTag', '14j_OutOfOrderRepeatingGroupMembers',
      '2g_PossDupNoOrigSendingTime', '2i_BeginStringValueUnexpected', '2k_CompIDDoesNotMatchProfile',
      '2o_SendingTimeValueOutOfRange', '2q_MsgTypeNotValid', 'QFJ648_NegativeHeartBtInt',
      'ReverseRoute', 'ReverseRouteWithEmptyRoutingTags',
    ),
    ...fix4('14i_RepeatingGroupCountNotEqual', '1d_InvalidLogonBadSendingTime', 'QFJ650_MissingMsgSeqNum'),
    ...fixt('14b_RequiredFieldMissing'),
    'fix42/14b_RequiredFieldMissing.def', 'fix44/QFJ934_MissingDelimiterNestedRepeatingGroup.def', 'fixLatest/LogonUnknownDefaultApplVerID.def',
  ], { reason: TEXT, ignore: [58] }),
  ...rule(every('14e_IncorrectEnumValue'), { reason: `${TEXT}; ${ECHO}`, ignore: [38, 58] }),
  ...rule(every('6_SendTestRequest'), { reason: TEST_REQ_ID, ignore: [112] }),
  ...rule([
    ...every('1b_DuplicateIdentity', '1c_InvalidSenderCompID', '1c_InvalidTargetCompID', '1d_InvalidLogonWrongBeginString', 'AlreadyLoggedOn'),
    ...fixt('1d_InvalidLogonBadSendingTime', '1d_InvalidLogonNoDefaultApplVerID'),
  ], { reason: SAYS_WHY, unread: ['5'] }),
  ...rule(every('10_MsgSeqNumEqual'), { reason: LOGOUT_TOO_LOW, failsAt: 14, arrives: ['5'] }),
  ...rule(fix4('14a_BadField'), { reason: `${TEXT}; ${NOT_A_TAG}; ${OWN_TRAFFIC}; ${SEQ_NOT_USED}`, ignore: [58], failsAt: 27, arrives: ['0', '1'] }),
  ...rule(fixt('14a_BadField'), { reason: `${TEXT}; ${LAYERS}; ${NOT_A_TAG}; ${OWN_TRAFFIC}; ${SEQ_NOT_USED}`, ignore: [58, 373], failsAt: 27, arrives: ['0', '1'] }),
  ...rule(['fix44/14b_RequiredFieldMissing.def'], { reason: `${TEXT}; ${SYMBOL_OPTIONAL}`, ignore: [58], failsAt: 22, arrives: ['D'] }),
  ...rule(fixt('14i_RepeatingGroupCountNotEqual'), { reason: `${TEXT}; ${SESSION_ID_VALUES}`, ignore: [58, 371, 373] }),
  ...rule(['fix50/21_RepeatingGroupSpecifierWithValueOfZero.def'], { reason: FIX50_AS_SP2, failsAt: 18, arrives: ['3'] }),
  ...rule(fixt('QFJ650_MissingMsgSeqNum'), { reason: `${TEXT}; ${LOGON_LINE}`, ignore: [58], extra: [1137] }),
  ...rule(every('2f_PossDupOrigSendingTimeTooHigh'), { reason: `${TEXT}; ${NO_LOGOUT}`, ignore: [58], failsAt: 20, arrives: ['nothing'] }),
  ...rule(every('2m_BodyLengthValueNotCorrect'), { reason: `${NO_QUEUE}; ${RESYNC}; ${LOGOUT_TOO_HIGH}`, failsAt: 18, arrives: ['nothing'] }),
  ...rule(every('RejectResentMessage'), { reason: `${TEXT}; ${NO_QUEUE}; ${LOGOUT_TOO_HIGH}`, ignore: [58], failsAt: 19, arrives: ['nothing'] }),
];
