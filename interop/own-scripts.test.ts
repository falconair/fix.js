// Scripts of our own, in the acceptance scripts' format, played against the
// same server: they hold fix.js to what the rulings in differences.ts say it
// does, and to what a script that stops early never gets to play. Needs
// neither Java nor the downloads.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptanceServer, playText } from './acceptance.ts';
import { parseScript } from './script.ts';

/**
 * A script as it is written here: `|` for SOH, `V` for the BeginString, `<APPL>`
 * at the end of a Logon for the application version FIXT.1.1 requires there
 * (FIX 5.0 SP2; nothing in FIX 4), and `E` lines without a BodyLength. Each `E`
 * line is given the BodyLength its own fields come to (the timestamps written as
 * 00000000-00:00:00.000 are as long as real ones), so a reply must match it to
 * the byte.
 */
function script(version: string, lines: readonly string[]): string {
  return lines.map(line => {
    const text = line.replace('8=V|', `8=${version}|`).replace('<APPL>', version === 'FIXT.1.1' ? '1137=9|' : '');
    if (!text.startsWith('E')) return text;
    const body = text.slice(text.indexOf('|') + 1);
    return `E8=${version}|9=${body.length}|${body}`;
  }).join('\n').replaceAll('|', '\x01');
}

/**
 * Play a script against a new server; what the script met, and what the server's application got wrong.
 * Every line of it must be a step: a line that is not is an error here, not passed over.
 */
async function played(version: string, lines: readonly string[]): Promise<unknown> {
  const text = script(version, lines);
  parseScript(text, { strict: true });
  const { server, errors } = await acceptanceServer();
  try {
    return { ...await playText(text, server.port), errors };
  } finally {
    await server.close();
  }
}

/** A script that ran to its end, with every reply as expected and nothing left unread. */
const AS_WRITTEN = { ignored: [], unread: [], errors: [] };

test('a script of our own may not have a line that is not a step', async () => {
  await assert.rejects(played('FIX.4.4', ['iCONNECT', 'I8=V|35=A|34=1|49=TW|52=<TIME>|56=ISLD|98=0|108=45|', ' eDISCONNECT']), /^Error: Line 3 is not a step: {2}eDISCONNECT$/);
});

const LOGON = [
  'iCONNECT',
  'I8=V|35=A|34=1|49=TW|52=<TIME>|56=ISLD|98=0|108=45|<APPL>',
  'E8=V|35=A|34=1|49=ISLD|52=00000000-00:00:00.000|56=TW|98=0|108=45|<APPL>',
];

/** The script logs out with MsgSeqNum `theirs`, and is answered with MsgSeqNum `ours`. */
const logout = (theirs: number, ours: number): string[] => [
  `I8=V|35=5|34=${theirs}|49=TW|52=<TIME>|56=ISLD|`,
  `E8=V|35=5|34=${ours}|49=ISLD|52=00000000-00:00:00.000|56=TW|`,
  'eDISCONNECT',
];

for (const version of ['FIX.4.2', 'FIX.4.4', 'FIXT.1.1']) {
  describe(`${version}: what the rulings say fix.js does`, { concurrency: 8 }, () => {
    test('a Logout whose MsgSeqNum is too low is answered with a Logout saying so, and the connection is closed', async () => {
      assert.deepEqual(await played(version, [
        ...LOGON,
        'I8=V|35=1|34=2|49=TW|52=<TIME>|56=ISLD|112=first|',
        'E8=V|35=0|34=2|49=ISLD|52=00000000-00:00:00.000|56=TW|112=first|',
        'I8=V|35=5|34=2|49=TW|52=<TIME>|56=ISLD|',
        'E8=V|35=5|34=3|49=ISLD|52=00000000-00:00:00.000|56=TW|58=MsgSeqNum too low, expecting 3 but received 2|',
        'eDISCONNECT',
      ]), AS_WRITTEN);
    });

    test('a Logout whose MsgSeqNum is too high gets a ResendRequest for what was missed, then its answer, and the connection is closed at once', async () => {
      assert.deepEqual(await played(version, [
        ...LOGON,
        'I8=V|35=5|34=7|49=TW|52=<TIME>|56=ISLD|',
        'E8=V|35=2|34=2|49=ISLD|52=00000000-00:00:00.000|56=TW|7=2|16=0|',
        'E8=V|35=5|34=3|49=ISLD|52=00000000-00:00:00.000|56=TW|',
        'eDISCONNECT',
      ]), AS_WRITTEN);
    });

    test('a resent message whose OrigSendingTime is later than its SendingTime is rejected, and the session carries on', async () => {
      assert.deepEqual(await played(version, [
        ...LOGON,
        'I8=V|35=1|34=2|43=Y|49=TW|52=<TIME>|56=ISLD|122=<TIME+20>|112=resent|',
        'E8=V|35=3|34=2|49=ISLD|52=00000000-00:00:00.000|56=TW|45=2|371=122|372=1|373=10|58=OrigSendingTime is later than SendingTime|',
        'I8=V|35=1|34=3|49=TW|52=<TIME>|56=ISLD|112=still here|',
        'E8=V|35=0|34=3|49=ISLD|52=00000000-00:00:00.000|56=TW|112=still here|',
        ...logout(4, 4),
      ]), AS_WRITTEN);
    });

    test('a resent message with a later OrigSendingTime and a MsgSeqNum already used is rejected too, and the next message in sequence is taken', async () => {
      assert.deepEqual(await played(version, [
        ...LOGON,
        'I8=V|35=1|34=2|49=TW|52=<TIME>|56=ISLD|112=one|',
        'E8=V|35=0|34=2|49=ISLD|52=00000000-00:00:00.000|56=TW|112=one|',
        'I8=V|35=1|34=2|43=Y|49=TW|52=<TIME>|56=ISLD|122=<TIME+20>|112=one|',
        'E8=V|35=3|34=3|49=ISLD|52=00000000-00:00:00.000|56=TW|45=2|371=122|372=1|373=10|58=OrigSendingTime is later than SendingTime|',
        'I8=V|35=1|34=3|49=TW|52=<TIME>|56=ISLD|112=still here|',
        'E8=V|35=0|34=4|49=ISLD|52=00000000-00:00:00.000|56=TW|112=still here|',
        ...logout(4, 5),
      ]), AS_WRITTEN);
    });

    test('a field whose tag is not a number makes the message garbled: it is not answered, and its MsgSeqNum is not used', async () => {
      assert.deepEqual(await played(version, [
        ...LOGON,
        'I8=V|35=1|34=2|49=TW|52=<TIME>|56=ISLD|112=garbled|-7=oops|',
        // Were the first one read, a Heartbeat or a Reject for it would come first; were its number used, this one would be too low.
        'I8=V|35=1|34=2|49=TW|52=<TIME>|56=ISLD|112=clean|',
        'E8=V|35=0|34=2|49=ISLD|52=00000000-00:00:00.000|56=TW|112=clean|',
        ...logout(3, 3),
      ]), AS_WRITTEN);
    });

    test('a user-defined tag (5000 and up) that no dictionary has is taken, and an order goes back with it; a tag below 5000 is rejected', async () => {
      assert.deepEqual(await played(version, [
        ...LOGON,
        'I8=V|35=1|34=2|49=TW|52=<TIME>|56=ISLD|112=with a tag of ours|6789=anything|',
        'E8=V|35=0|34=2|49=ISLD|52=00000000-00:00:00.000|56=TW|112=with a tag of ours|',
        'I8=V|35=D|34=3|49=TW|52=<TIME>|56=ISLD|11=order-7|21=1|55=ACME|54=2|60=<TIME>|40=1|38=300|7001=desk 4|',
        'E8=V|35=D|34=3|49=ISLD|52=00000000-00:00:00.000|56=TW|11=order-7|21=1|55=ACME|54=2|60=00000000-00:00:00.000|40=1|38=300|7001=desk 4|',
        'I8=V|35=1|34=4|49=TW|52=<TIME>|56=ISLD|112=below 5000|4999=no|',
        `E8=V|35=3|34=4|49=ISLD|52=00000000-00:00:00.000|56=TW|45=4|371=4999|372=1|373=0|58=Tag 4999 is not defined in ${version}|`,
        ...logout(5, 5),
      ]), AS_WRITTEN);
    });

    test('after a message whose BodyLength is too large the one that follows is read: it is ahead of sequence, and a resend is asked for', async () => {
      assert.deepEqual(await played(version, [
        ...LOGON,
        // Its fields come to 62 bytes.
        'I8=V|9=75|35=1|34=2|49=TW|52=<TIME>|56=ISLD|112=too long|',
        'I8=V|35=1|34=3|49=TW|52=<TIME>|56=ISLD|112=the one after|',
        'E8=V|35=2|34=2|49=ISLD|52=00000000-00:00:00.000|56=TW|7=2|16=0|',
        'I8=V|35=4|34=2|43=Y|49=TW|52=<TIME>|56=ISLD|122=<TIME>|123=Y|36=4|',
        'I8=V|35=1|34=4|49=TW|52=<TIME>|56=ISLD|112=back in step|',
        'E8=V|35=0|34=3|49=ISLD|52=00000000-00:00:00.000|56=TW|112=back in step|',
        ...logout(5, 4),
      ]), AS_WRITTEN);
    });

    test('a message ahead of sequence gets a ResendRequest for everything from the gap on, and is not kept: it is taken when it is sent again', async () => {
      assert.deepEqual(await played(version, [
        ...LOGON,
        'I8=V|35=1|34=4|49=TW|52=<TIME>|56=ISLD|112=ahead|',
        'E8=V|35=2|34=2|49=ISLD|52=00000000-00:00:00.000|56=TW|7=2|16=0|',
        'I8=V|35=4|34=2|43=Y|49=TW|52=<TIME>|56=ISLD|122=<TIME>|123=Y|36=4|',
        // Had the first one been kept, its Heartbeat (112=ahead) would come now.
        'I8=V|35=1|34=4|43=Y|49=TW|52=<TIME>|56=ISLD|122=<TIME>|112=ahead, sent again|',
        'E8=V|35=0|34=3|49=ISLD|52=00000000-00:00:00.000|56=TW|112=ahead, sent again|',
        ...logout(5, 4),
      ]), AS_WRITTEN);
    });

    test('while a resend is awaited, what comes ahead of sequence is dropped without another ResendRequest, and a Logout is answered and the connection closed', async () => {
      assert.deepEqual(await played(version, [
        ...LOGON,
        'I8=V|35=1|34=4|49=TW|52=<TIME>|56=ISLD|112=ahead|',
        'E8=V|35=2|34=2|49=ISLD|52=00000000-00:00:00.000|56=TW|7=2|16=0|',
        'I8=V|35=1|34=5|49=TW|52=<TIME>|56=ISLD|112=further ahead|',
        'I8=V|35=5|34=6|49=TW|52=<TIME>|56=ISLD|',
        'E8=V|35=5|34=3|49=ISLD|52=00000000-00:00:00.000|56=TW|',
        'eDISCONNECT',
      ]), AS_WRITTEN);
    });

    test('a NewOrderSingle without Side is rejected for the field that is missing, and the session carries on', async () => {
      assert.deepEqual(await played(version, [
        ...LOGON,
        'I8=V|35=D|34=2|49=TW|52=<TIME>|56=ISLD|11=order-8|21=1|55=ACME|60=<TIME>|40=1|38=300|',
        'E8=V|35=3|34=2|49=ISLD|52=00000000-00:00:00.000|56=TW|45=2|371=54|372=D|373=1|58=Side (54) is required|',
        'I8=V|35=1|34=3|49=TW|52=<TIME>|56=ISLD|112=still here|',
        'E8=V|35=0|34=3|49=ISLD|52=00000000-00:00:00.000|56=TW|112=still here|',
        ...logout(4, 4),
      ]), AS_WRITTEN);
    });
  });
}

const ORDER_WITHOUT_SYMBOL = 'I8=V|35=D|34=2|49=TW|52=<TIME>|56=ISLD|11=order-9|21=1|54=2|60=<TIME>|40=1|38=300|';

test('FIX.4.2: a NewOrderSingle without Symbol is rejected for it', async () => {
  assert.deepEqual(await played('FIX.4.2', [
    ...LOGON,
    ORDER_WITHOUT_SYMBOL,
    'E8=V|35=3|34=2|49=ISLD|52=00000000-00:00:00.000|56=TW|45=2|371=55|372=D|373=1|58=Symbol (55) is required|',
    ...logout(3, 3),
  ]), AS_WRITTEN);
});

test('FIX.4.4: a NewOrderSingle without Symbol is taken, and goes back as it came', async () => {
  assert.deepEqual(await played('FIX.4.4', [
    ...LOGON,
    ORDER_WITHOUT_SYMBOL,
    'E8=V|35=D|34=2|49=ISLD|52=00000000-00:00:00.000|56=TW|11=order-9|21=1|54=2|60=00000000-00:00:00.000|40=1|38=300|',
    ...logout(3, 3),
  ]), AS_WRITTEN);
});

describe('FIXT.1.1: application versions, and the one dictionary they are read with', { concurrency: 8 }, () => {
  const FIXT = 'FIXT.1.1';
  /** Log on naming the application version with this wire value of DefaultApplVerID; the answer names the same. */
  const logonAs = (applVerID: string): string[] => [
    'iCONNECT',
    `I8=V|35=A|34=1|49=TW|52=<TIME>|56=ISLD|98=0|108=45|1137=${applVerID}|`,
    `E8=V|35=A|34=1|49=ISLD|52=00000000-00:00:00.000|56=TW|98=0|108=45|1137=${applVerID}|`,
  ];
  const ORDER = '11=order-7|21=1|55=ACME|54=2|60=<TIME>|40=1|38=300|';
  const ECHOED = '11=order-7|21=1|55=ACME|54=2|60=00000000-00:00:00.000|40=1|38=300|';

  test('a Logon is answered with the application version it names, for each of the four fix.js reads', async () => {
    for (const applVerID of ['7', '8', '9', '10']) {
      assert.deepEqual(await played(FIXT, [...logonAs(applVerID), ...logout(2, 2)]), AS_WRITTEN, `DefaultApplVerID ${applVerID}`);
    }
  });

  test('a Logon that names no application version, or one fix.js does not read, is answered with a Logout saying so, and the connection is closed', async () => {
    const refused = (logon: string, text: string): Promise<unknown> => played(FIXT, [
      'iCONNECT',
      `I8=V|35=A|34=1|49=TW|52=<TIME>|56=ISLD|98=0|108=45|${logon}`,
      `E8=V|35=5|34=1|49=ISLD|52=00000000-00:00:00.000|56=TW|58=${text}|`,
      'eDISCONNECT',
    ]);
    const use = 'use FIX50, FIX50SP1, FIX50SP2 or FIXLatest';
    assert.deepEqual(await refused('', 'DefaultApplVerID (1137) is required in a FIXT.1.1 Logon'), AS_WRITTEN);
    assert.deepEqual(await refused('1137=6|', `DefaultApplVerID FIX44 is not supported; ${use}`), AS_WRITTEN);
    assert.deepEqual(await refused('1137=33|', `DefaultApplVerID 33 is not supported; ${use}`), AS_WRITTEN);
  });

  test('an application message that names an application version fix.js does not read is rejected, and the session carries on; one of the four is taken, and a session message is not held to it', async () => {
    assert.deepEqual(await played(FIXT, [
      ...logonAs('9'),
      `I8=V|35=D|1128=6|34=2|49=TW|52=<TIME>|56=ISLD|${ORDER}`,
      'E8=V|35=3|34=2|49=ISLD|52=00000000-00:00:00.000|56=TW|45=2|371=1128|372=D|373=18|58=ApplVerID FIX44 is not supported; use FIX50, FIX50SP1, FIX50SP2 or FIXLatest|',
      `I8=V|35=D|1128=10|34=3|49=TW|52=<TIME>|56=ISLD|${ORDER}`,
      `E8=V|35=D|1128=10|34=3|49=ISLD|52=00000000-00:00:00.000|56=TW|${ECHOED}`,
      'I8=V|35=1|1128=6|34=4|49=TW|52=<TIME>|56=ISLD|112=whatever it names|',
      'E8=V|35=0|34=4|49=ISLD|52=00000000-00:00:00.000|56=TW|112=whatever it names|',
      ...logout(5, 5),
    ]), AS_WRITTEN);
  });

  test('a field of the application layer on a session message is not defined for that message', async () => {
    assert.deepEqual(await played(FIXT, [
      ...logonAs('9'),
      // 999 is LegUnitOfMeasure in FIX 5.0 SP2: a tag the dictionary has, in a message that does not.
      'I8=V|35=0|34=2|49=TW|52=<TIME>|56=ISLD|999=MWh|',
      'E8=V|35=3|34=2|49=ISLD|52=00000000-00:00:00.000|56=TW|45=2|371=999|372=0|373=2|58=LegUnitOfMeasure (999) is not defined for this message type|',
      ...logout(3, 3),
    ]), AS_WRITTEN);
  });

  test('TradingSessionID takes the values its dictionary gives it and the ones left open to agreement, and no other; with a value it takes, a wrong count is rejected as that', async () => {
    assert.deepEqual(await played(FIXT, [
      ...logonAs('9'),
      `I8=V|35=D|34=2|49=TW|52=<TIME>|56=ISLD|${ORDER}386=1|336=BEFORE-DAWN|`,
      "E8=V|35=3|34=2|49=ISLD|52=00000000-00:00:00.000|56=TW|45=2|371=336|372=D|373=5|58=TradingSessionID (336) has no value 'BEFORE-DAWN'|",
      `I8=V|35=D|34=3|49=TW|52=<TIME>|56=ISLD|${ORDER}386=2|336=1|`,
      'E8=V|35=3|34=3|49=ISLD|52=00000000-00:00:00.000|56=TW|45=3|371=386|372=D|373=16|58=NoTradingSessions (386) says 2 but 1 TrdgSesGrp entries follow|',
      // 100 and up are for counterparties to agree on.
      `I8=V|35=D|34=4|49=TW|52=<TIME>|56=ISLD|${ORDER}386=1|336=100|`,
      `E8=V|35=D|34=4|49=ISLD|52=00000000-00:00:00.000|56=TW|${ECHOED}386=1|336=100|`,
      ...logout(5, 5),
    ]), AS_WRITTEN);
  });

  test('a session that names FIX 5.0 is read with the FIX Latest dictionary: a SecurityDefinition with TradingSessionID among its own fields is rejected, and one without is sent back', async () => {
    assert.deepEqual(await played(FIXT, [
      ...logonAs('7'),
      'I8=V|35=d|34=2|49=TW|52=<TIME>|56=ISLD|320=REQ-1|322=RESP-1|323=1|55=ACME|336=1|',
      'E8=V|35=3|34=2|49=ISLD|52=00000000-00:00:00.000|56=TW|45=2|371=336|372=d|373=2|58=TradingSessionID (336) is not defined for this message type|',
      // It has no TransactTime, and goes back without one.
      'I8=V|35=d|34=3|49=TW|52=<TIME>|56=ISLD|320=REQ-1|322=RESP-1|323=1|55=ACME|',
      'E8=V|35=d|34=3|49=ISLD|52=00000000-00:00:00.000|56=TW|320=REQ-1|322=RESP-1|323=1|55=ACME|',
      ...logout(4, 4),
    ]), AS_WRITTEN);
  });
});
