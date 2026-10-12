import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Timer;
import java.util.TimerTask;

import org.apache.mina.core.service.IoAcceptor;

import quickfix.Application;
import quickfix.DefaultMessageFactory;
import quickfix.Log;
import quickfix.LogFactory;
import quickfix.MemoryStoreFactory;
import quickfix.Message;
import quickfix.Session;
import quickfix.SessionID;
import quickfix.SessionSettings;
import quickfix.SocketAcceptor;
import quickfix.SocketInitiator;

/**
 * One QuickFIX/J session, driven over stdin and stdout by the interop tests.
 *
 * Arguments: role (acceptor | initiator), BeginString, our CompID, their CompID,
 * port (an acceptor's 0 means any free port), HeartBtInt in seconds (used by an
 * initiator), and optionally "reset" (ResetOnLogon=Y). With BeginString FIXT.1.1
 * the session carries FIX 5.0 SP2 (DefaultApplVerID 9).
 *
 * It prints one line per event, tab-separated, with SOH shown as '|':
 *   ready <port>      listening (acceptor) or started (initiator)
 *   logon             the session logged on
 *   logout            the session logged out or lost its connection
 *   in <message>      a message QuickFIX/J accepted (fromAdmin, fromApp)
 *   out <message>     a message QuickFIX/J is about to send (toAdmin, toApp)
 *   event <text>      a line of QuickFIX/J's own session log
 *   done <command>    the command has been carried out (one per command, in the order the commands were read)
 *   failed <text>     the command could not be carried out (instead of its done line)
 *   error <text>      something else went wrong, such as answering an order
 *
 * It reads one command per line:
 *   order <ClOrdID> [<value>]  send a NewOrderSingle; with a value, the order carries it as its ApplVerID (1128)
 *   testrequest <TestReqID>    send a TestRequest
 *   seq sender|target <n>      set the next MsgSeqNum to send, or to expect
 *   sequencereset <NewSeqNo>   send a SequenceReset (reset mode), and send NewSeqNo next
 *   logout                     log out, and stay logged out
 *   logon                      allow logging on again (an initiator reconnects)
 *   stop                       exit (no done line)
 *
 * As an acceptor it answers each NewOrderSingle with two ExecutionReports: New, then Filled.
 * It exits when stdin closes, so it never outlives the process that started it,
 * and after ten minutes whatever happens.
 */
public final class Harness implements Application {
    private static final long LIFETIME_MS = 10 * 60 * 1000;

    private final SessionID sessionID;
    private final boolean answersOrders;
    private int executions = 0;

    private Harness(SessionID sessionID, boolean answersOrders) {
        this.sessionID = sessionID;
        this.answersOrders = answersOrders;
    }

    public static void main(String[] args) throws Exception {
        if (args.length < 6) {
            System.err.println("usage: Harness acceptor|initiator BeginString sender target port heartbeat [reset]");
            System.exit(2);
        }
        boolean acceptor = args[0].equals("acceptor");
        SessionID sessionID = new SessionID(args[1], args[2], args[3]);
        boolean reset = args.length > 6 && args[6].equals("reset");

        Timer lifetime = new Timer(true);
        lifetime.schedule(new TimerTask() {
            @Override public void run() { Runtime.getRuntime().halt(3); }
        }, LIFETIME_MS);

        SessionSettings settings = new SessionSettings();
        settings.setString("ConnectionType", acceptor ? "acceptor" : "initiator");
        settings.setString("NonStopSession", "Y");
        settings.setString("UseDataDictionary", "Y");
        settings.setString("ResetOnLogon", reset ? "Y" : "N");
        settings.setString(sessionID, "BeginString", sessionID.getBeginString());
        settings.setString(sessionID, "SenderCompID", sessionID.getSenderCompID());
        settings.setString(sessionID, "TargetCompID", sessionID.getTargetCompID());
        if (sessionID.isFIXT()) settings.setString(sessionID, "DefaultApplVerID", "FIX.5.0SP2");
        if (acceptor) {
            settings.setString("SocketAcceptAddress", "127.0.0.1");
            settings.setString("SocketAcceptPort", args[4]);
        } else {
            settings.setString("SocketConnectHost", "127.0.0.1");
            settings.setString("SocketConnectPort", args[4]);
            settings.setString("HeartBtInt", args[5]);
            settings.setString("ReconnectInterval", "1");
        }

        Harness harness = new Harness(sessionID, acceptor);
        LogFactory logs = id -> new EventLog();
        if (acceptor) {
            SocketAcceptor engine = new SocketAcceptor(harness, new MemoryStoreFactory(), settings, logs, new DefaultMessageFactory());
            engine.start();
            int port = 0;
            for (IoAcceptor endpoint : engine.getEndpoints()) {
                port = ((InetSocketAddress) endpoint.getLocalAddress()).getPort();
            }
            print("ready", Integer.toString(port));
        } else {
            SocketInitiator engine = new SocketInitiator(harness, new MemoryStoreFactory(), settings, logs, new DefaultMessageFactory());
            engine.start();
            print("ready", args[4]);
        }

        BufferedReader commands = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.ISO_8859_1));
        for (String line = commands.readLine(); line != null; line = commands.readLine()) {
            String[] words = line.trim().split(" +");
            if (words[0].equals("stop")) break;
            try {
                harness.command(words);
                print("done", line);
            } catch (Exception e) {
                print("failed", line + ": " + e);
            }
        }
        // halt, not exit: nothing QuickFIX/J or MINA still has running may hold the process open.
        Runtime.getRuntime().halt(0);
    }

    private void command(String[] words) throws Exception {
        Session session = Session.lookupSession(sessionID);
        switch (words[0]) {
            case "order":
                session.send(newOrderSingle(words[1], words.length > 2 ? words[2] : null));
                break;
            case "testrequest":
                session.generateTestRequest(words[1]);
                break;
            case "seq":
                if (words[1].equals("sender")) session.setNextSenderMsgSeqNum(Integer.parseInt(words[2]));
                else session.setNextTargetMsgSeqNum(Integer.parseInt(words[2]));
                break;
            case "sequencereset": {
                Message message = message("4");
                message.setInt(36, Integer.parseInt(words[1]));
                session.send(message);
                session.setNextSenderMsgSeqNum(Integer.parseInt(words[1]));
                break;
            }
            case "logout":
                session.logout();
                break;
            case "logon":
                session.logon();
                break;
            case "":
                break;
            default:
                throw new IllegalArgumentException("unknown command " + words[0]);
        }
    }

    private boolean fix42() {
        return sessionID.getBeginString().equals("FIX.4.2");
    }

    private Message message(String msgType) {
        Message message = new Message();
        message.getHeader().setString(8, sessionID.getBeginString());
        message.getHeader().setString(35, msgType);
        return message;
    }

    /** Buy 100 IBM at 10, as a limit order; with an applVerID, the order names it as its application version. */
    private Message newOrderSingle(String clOrdID, String applVerID) {
        Message order = message("D");
        if (applVerID != null) order.getHeader().setString(1128, applVerID);
        order.setString(11, clOrdID);
        if (fix42()) order.setString(21, "1");
        order.setString(55, "IBM");
        order.setString(54, "1");
        order.setUtcTimeStamp(60, java.time.LocalDateTime.now(java.time.ZoneOffset.UTC), true);
        order.setString(38, "100");
        order.setString(40, "2");
        order.setString(44, "10");
        return order;
    }

    /** An ExecutionReport for `order`: New (filled == false), or Filled in full at the order's price. */
    private Message executionReport(Message order, boolean filled) throws Exception {
        String quantity = order.getString(38);
        String price = order.isSetField(44) ? order.getString(44) : "0";
        Message report = message("8");
        report.setString(37, "ORDER-" + order.getString(11));
        report.setString(11, order.getString(11));
        report.setString(17, "EXEC-" + (++executions));
        if (fix42()) report.setString(20, "0");
        report.setString(150, filled ? (fix42() ? "2" : "F") : "0");
        report.setString(39, filled ? "2" : "0");
        report.setString(55, order.getString(55));
        report.setString(54, order.getString(54));
        report.setString(38, quantity);
        if (filled) {
            report.setString(32, quantity);
            report.setString(31, price);
        }
        report.setString(151, filled ? "0" : quantity);
        report.setString(14, filled ? quantity : "0");
        report.setString(6, filled ? price : "0");
        return report;
    }

    private static synchronized void print(String event, String detail) {
        System.out.println(event + "\t" + detail.replace('\u0001', '|'));
        System.out.flush();
    }

    @Override public void onCreate(SessionID id) { }
    @Override public void onLogon(SessionID id) { print("logon", id.toString()); }
    @Override public void onLogout(SessionID id) { print("logout", id.toString()); }
    @Override public void toAdmin(Message message, SessionID id) { print("out", message.toString()); }
    @Override public void toApp(Message message, SessionID id) { print("out", message.toString()); }
    @Override public void fromAdmin(Message message, SessionID id) { print("in", message.toString()); }

    @Override public void fromApp(Message message, SessionID id) {
        print("in", message.toString());
        try {
            if (answersOrders && message.getHeader().getString(35).equals("D")) {
                Session session = Session.lookupSession(id);
                session.send(executionReport(message, false));
                session.send(executionReport(message, true));
            }
        } catch (Exception e) {
            print("error", "answering an order: " + e);
        }
    }

    /** QuickFIX/J's session log, as event lines; the messages themselves are reported by the Application callbacks. */
    private static final class EventLog implements Log {
        @Override public void clear() { }
        @Override public void onIncoming(String message) { }
        @Override public void onOutgoing(String message) { }
        @Override public void onEvent(String text) { print("event", text); }
        @Override public void onErrorEvent(String text) { print("event", text); }
    }
}
