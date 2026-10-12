import type { MessageObject } from '../wire/message.ts';

/** Session messages are never resent; a SequenceReset-GapFill covers them. */
const GAP_FILLED: ReadonlySet<string> = new Set(['Logon', 'Logout', 'Heartbeat', 'TestRequest', 'ResendRequest', 'SequenceReset']);

/** One message of the answer to a ResendRequest: its MsgSeqNum written, the rest of its header left for the session to fill as it sends it. */
export interface PlannedSend {
  readonly msgType: string;
  readonly fields: Record<string, unknown>;
}

/** The answer to one ResendRequest, planned an original at a time. */
export interface ResendPlan {
  /**
   * The original found for `seq`. Each call's `seq` is higher than the one before; a MsgSeqNum no
   * call names is missing. Returns what can now be sent: the gap fill that covers what came before
   * it, when there is one, and the original itself when it is an application message.
   */
  next(seq: number, original: MessageObject, now: number): PlannedSend[];
  /** No more originals: the gap fill that covers the rest of the range, if any. */
  end(now: number): PlannedSend[];
}

/**
 * Plans the answer to a ResendRequest for from..to without holding the range: application messages
 * go again with PossDupFlag=Y and OrigSendingTime; session messages and anything missing are
 * collapsed into SequenceReset-GapFill. A gap fill's OrigSendingTime is the SendingTime of the
 * session message it begins with, or `now` when it begins with a missing one. An original the plan
 * has passed, or one outside the range, is ignored.
 */
export function resendPlan(from: number, to: number): ResendPlan {
  /** The lowest MsgSeqNum nothing has been planned for yet. */
  let cursor = from;
  /** Where the gap being collected began; undefined while there is none. */
  let gapStart: number | undefined;
  let gapOrigSendingTime: unknown;
  /** The gap fill for everything from the open gap, or from the cursor, up to `before`; none when there is nothing between. */
  const closeGap = (before: number, now: number): PlannedSend[] => {
    const start = gapStart ?? cursor;
    if (start >= before) return [];
    const fill: PlannedSend = { msgType: 'SequenceReset', fields: gapFill(start, before, gapOrigSendingTime ?? new Date(now)) };
    gapStart = undefined;
    gapOrigSendingTime = undefined;
    return [fill];
  };
  return {
    next(seq, original, now) {
      if (seq < cursor || seq > to) return [];
      const msgType = original.MsgType;
      if (typeof msgType !== 'string' || GAP_FILLED.has(msgType)) {
        if (gapStart === undefined) {
          gapStart = cursor;
          gapOrigSendingTime = seq === cursor ? original.SendingTime : undefined;
        }
        cursor = seq + 1;
        return [];
      }
      const out = closeGap(seq, now);
      out.push({ msgType, fields: resent(original, seq) });
      cursor = seq + 1;
      return out;
    },
    end(now) {
      const out = closeGap(to + 1, now);
      cursor = to + 1;
      return out;
    },
  };
}

function gapFill(seq: number, newSeqNo: number, origSendingTime: unknown): Record<string, unknown> {
  return { MsgSeqNum: seq, PossDupFlag: true, GapFillFlag: true, NewSeqNo: newSeqNo, OrigSendingTime: origSendingTime };
}

function resent(original: MessageObject, seq: number): Record<string, unknown> {
  const { MsgType: _msgType, SendingTime, ...fields } = original;
  return { ...fields, MsgSeqNum: seq, PossDupFlag: true, OrigSendingTime: SendingTime };
}
