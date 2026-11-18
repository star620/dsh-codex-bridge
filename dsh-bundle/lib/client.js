window.__ModuleLoader__.load({
  id: "@local/codex-bridge",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");
    var h = React.createElement;

    var NS = "codex-bridge";
    // Overridable so the dev harness (or a second bus on another port) can point the
    // panel elsewhere. Unset in the app, where the bus always lives on its default port.
    var BUS = (typeof window !== "undefined" && window.__CODEX_BRIDGE_BUS__) || "http://127.0.0.1:8787";
    var POLL_MS = 5000;

    var KIND_COLOR = {
      task: "var(--dsw-alias-state-business-primary)",
      result: "var(--dsw-alias-state-success-primary)",
      question: "var(--dsw-alias-state-warn-primary)",
      note: "var(--dsw-alias-label-tertiary)",
    };

    function pad(n) { return String(n).padStart(2, "0"); }

    function fmtClock(value) {
      var d = new Date(value);
      if (isNaN(d.getTime())) return "";
      var now = new Date();
      var hm = pad(d.getHours()) + ":" + pad(d.getMinutes());
      if (d.toDateString() === now.toDateString()) return hm;
      return pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + hm;
    }

    function fmtAgo(seconds) {
      var s = Math.max(0, Math.round(Number(seconds) || 0));
      if (s < 60) return s + " 秒前";
      if (s < 3600) return Math.round(s / 60) + " 分钟前";
      if (s < 86400) return Math.round(s / 3600) + " 小时前";
      return Math.round(s / 86400) + " 天前";
    }

    function label(text) {
      return h("div", {
        style: {
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: 0.3,
          color: "var(--dsw-alias-label-secondary)",
        },
      }, text);
    }

    function Empty(props) {
      return h("div", {
        style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", padding: "6px 0" },
      }, props.text);
    }

    function Pill(props) {
      var color = props.color || "var(--dsw-alias-label-tertiary)";
      return h("span", {
        style: {
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          fontSize: 11,
          lineHeight: "16px",
          padding: "1px 6px",
          borderRadius: 999,
          color: color,
          border: "1px solid " + (props.border || color),
          whiteSpace: "nowrap",
        },
      }, props.text);
    }

    function Dot(props) {
      return h("span", {
        style: {
          display: "inline-block",
          width: 7,
          height: 7,
          borderRadius: 999,
          background: props.on ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-border-l3)",
          boxShadow: props.on ? "0 0 0 3px rgba(76,195,138,0.18)" : "none",
          flex: "0 0 auto",
        },
      });
    }

    function PeerCard(props) {
      var p = props.peer;
      var unread = Number(p.unread) || 0;
      return h("div", {
        style: {
          flex: "1 1 0",
          minWidth: 150,
          padding: "8px 10px",
          borderRadius: 8,
          border: "1px solid var(--dsw-alias-border-l3)",
          background: "var(--dsw-alias-bg-base)",
          display: "flex",
          flexDirection: "column",
          gap: 4,
        },
      },
        h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
          h(Dot, { on: unread === 0 }),
          h("span", { style: { fontSize: 13, fontWeight: 600 } }, p.peer),
          unread > 0
            ? h(Pill, { text: unread + " 未读", color: "var(--dsw-alias-state-warn-primary)" })
            : h(Pill, { text: "已读完", color: "var(--dsw-alias-state-success-primary)" })
        ),
        h("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)" } },
          "读至 seq " + (Number(p.cursor) || 0))
      );
    }

    function MessageRow(props) {
      var m = props.message;
      var color = KIND_COLOR[m.kind] || KIND_COLOR.note;
      var meta = [m.from + " → " + m.to];
      if (m.target) meta.push("@" + String(m.target).replace(/^session-/, ""));
      var project = m.project || m.projectId;
      if (project) meta.push("#" + project);
      // A claim is a lease and can still come back; a delivery cannot. The panel must not
      // show them as the same word, or a stuck claim looks like a finished task.
      var d = m.delivery;
      // expiresIn is the lease, not a deadline for the work: say so, otherwise 42s reads as
      // "this task must finish in 42 seconds".
      if (d && d.state === "claimed") meta.push("在途 " + (d.peer || "?") + " · 租约剩 " + (d.expiresIn || 0) + "s");
      else if ((d && d.target) || m.deliveredBy) {
        meta.push("已投 " + ((d && d.target) || m.deliveredBy));
        var turnState = d && d.turn && d.turn.state;
        meta.push(turnState === "completed" ? "本轮结束" : turnState === "failed" ? "执行失败" : turnState === "running" ? "运行中" : "未知");
      }
      // Bodies arrive as typed, and a JSON-stringified task carries literal "\\n"
      // escapes; collapse those into spacing so the preview reads as one line.
      var body = String(m.body || "").replace(/\\n/g, " ").replace(/\s+/g, " ").slice(0, 200);
      return h("div", {
        style: {
          display: "flex",
          gap: 8,
          padding: "7px 0",
          borderBottom: "1px solid var(--dsw-alias-border-l3)",
          alignItems: "flex-start",
        },
      },
        h("span", {
          style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", width: 52, flex: "0 0 auto", paddingTop: 1 },
        }, "#" + m.seq + " " + fmtClock(m.ts)),
        h("span", {
          style: { fontSize: 11, color: color, width: 48, flex: "0 0 auto", paddingTop: 1 },
        }, m.kind || "note"),
        h("div", { style: { minWidth: 0, flex: "1 1 auto" } },
          h("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", marginBottom: 2 } }, meta.join("  ")),
          h("div", { style: { fontSize: 12.5, color: "var(--dsw-alias-label-primary)", wordBreak: "break-word" } }, body)
        )
      );
    }

    function ThreadRow(props) {
      var t = props.thread;
      return h("div", {
        style: {
          display: "flex",
          gap: 8,
          alignItems: "flex-start",
          padding: "7px 0",
          borderBottom: "1px solid var(--dsw-alias-border-l3)",
        },
      },
        h("span", { style: { paddingTop: 5 } }, h(Dot, { on: !!t.active })),
        h("div", { style: { minWidth: 0, flex: "1 1 auto" } },
          h("div", {
            style: { fontSize: 12.5, color: "var(--dsw-alias-label-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
          }, t.lastUser || t.label || t.id),
          h("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", marginTop: 2 } },
            (t.cwd ? t.cwd.split(/[\\/]/).pop() + " · " : "") + fmtAgo(t.ageSeconds) + (t.status ? " · " + t.status : "") + (t.source ? " · " + t.source : ""))
        )
      );
    }

    // The bus is a local process that can be down, mid-upgrade, or replaced by something
    // else on the port, so nothing is trusted until it has the shape the panel needs.
    function normalize(raw) {
      if (!raw || typeof raw !== "object") throw new Error("总线返回的不是对象");
      if (raw.ok === false) throw new Error(String(raw.error || "总线返回 ok:false"));
      var keep = function (list) {
        return Array.isArray(list) ? list.filter(function (x) { return x && typeof x === "object"; }) : [];
      };
      return {
        seq: Number(raw.seq) || 0,
        generatedAt: raw.generatedAt,
        dir: typeof raw.dir === "string" ? raw.dir : "",
        peers: keep(raw.peers).filter(function (p) { return typeof p.peer === "string" && p.peer; }),
        // Fields are coerced, not just checked: React refuses to render an object child, and a
        // bus upgraded mid-flight can hand us a nested project or a numeric kind.
        recent: keep(raw.recent)
          .filter(function (m) { return Number.isFinite(Number(m.seq)); })
          .map(function (m) {
            var proj = typeof m.project === "string" ? m.project : (typeof m.projectId === "string" ? m.projectId : "");
            return {
              seq: Number(m.seq),
              ts: typeof m.ts === "string" ? m.ts : "",
              from: String(m.from == null ? "" : m.from),
              to: String(m.to == null ? "" : m.to),
              kind: typeof m.kind === "string" ? m.kind : "note",
              target: typeof m.target === "string" ? m.target : "",
              project: proj,
              delivery: m.delivery && typeof m.delivery === "object" ? m.delivery : null,
              deliveredBy: typeof m.deliveredBy === "string" ? m.deliveredBy : "",
              body: typeof m.body === "string" ? String(m.body) : ""
            };
          }),
        codex: keep(raw.codex),
        lanes: raw.lanes && typeof raw.lanes === "object" ? raw.lanes : {},
        // Grouped by the bus from the cwds it saw; the panel never derives ids itself,
        // so what it shows is exactly what /inbox?project= would answer.
        projects: keep(raw.projects)
          .filter(function (p) { return typeof p.id === "string" && p.id; })
          .map(function (p) {
            return {
              id: String(p.id),
              cwd: typeof p.cwd === "string" ? p.cwd : "",
              sessions: Number(p.sessions) || 0,
              threads: Number(p.threads) || 0,
              unread: Number(p.unread) || 0,
              codexUnread: Number(p.codexUnread) || 0
            };
          }),
      };
    }

    function BridgePanel(props) {
      var sessionId = String(props.sessionId || "");
      var state = React.useState({ data: null, error: "", loading: true });
      var snap = state[0];
      var setSnap = state[1];
      var autoState = React.useState(true);
      var auto = autoState[0];
      var setAuto = autoState[1];

      var ctrlRef = React.useRef(null);
      var reqRef = React.useRef(0);
      var aliveRef = React.useRef(true);

      var load = React.useCallback(function () {
        var myReq = ++reqRef.current;
        // Only the newest request may touch state: a slow answer from 5 seconds ago must
        // not overwrite a fresher snapshot (or resurrect an error that is already gone).
        if (ctrlRef.current) { try { ctrlRef.current.abort(); } catch (err) {} }
        var ctrl = typeof AbortController === "function" ? new AbortController() : null;
        ctrlRef.current = ctrl;
        var timer = ctrl ? setTimeout(function () {
          if (ctrlRef.current === ctrl) ctrl.abort();
        }, 4000) : null;
        var settle = function () { if (timer) clearTimeout(timer); };
        fetch(BUS + "/status", { signal: ctrl ? ctrl.signal : undefined })
          .then(function (res) {
            if (!res.ok) throw new Error("HTTP " + res.status);
            return res.json();
          })
          .then(function (raw) {
            settle();
            if (!aliveRef.current || myReq !== reqRef.current) return;
            setSnap({ data: normalize(raw), error: "", loading: false });
          })
          .catch(function (err) {
            settle();
            if (!aliveRef.current || myReq !== reqRef.current) return;
            setSnap(function (prev) {
              return { data: prev.data, error: String((err && err.message) || err), loading: false };
            });
          });
      }, []);

      React.useEffect(function () {
        aliveRef.current = true;
        return function () {
          aliveRef.current = false;
          if (ctrlRef.current) { try { ctrlRef.current.abort(); } catch (err) {} }
        };
      }, []);

      React.useEffect(function () {
        load();
        if (!auto) return undefined;
        var id = setInterval(function () {
          if (typeof document !== "undefined" && document.hidden) return;
          load();
        }, POLL_MS);
        return function () { clearInterval(id); };
      }, [auto, load]);

      React.useEffect(function () {
        // Cheap, checkable proof that this view really mounted inside the app:
        // the bus remembers the ping and shows it in /status -> panels.
        var ctrl = typeof AbortController === "function" ? new AbortController() : null;
        var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 4000) : null;
        fetch(BUS + "/panel/ping?session=" + encodeURIComponent(sessionId), { signal: ctrl ? ctrl.signal : undefined })
          .catch(function () {})
          .then(function () { if (timer) clearTimeout(timer); });
        return function () {
          if (timer) clearTimeout(timer);
          if (ctrl) { try { ctrl.abort(); } catch (err) {} }
        };
      }, [sessionId]);

      // normalize() already guaranteed these shapes; no "|| []" guesses here.
      var data = snap.data;
      var peers = data ? data.peers : [];
      var recent = data ? data.recent : [];
      var threads = data ? data.codex : [];
      var projects = data ? data.projects : [];
      var lanes = data ? Object.keys(data.lanes) : [];
      var online = !!data && !snap.error;

      if (snap.loading && !data) {
        return h("div", { style: { padding: 20, fontSize: 13, color: "var(--dsw-alias-label-tertiary)" } }, "正在读取总线…");
      }

      return h("div", {
        style: {
          padding: "16px 20px 28px",
          height: "100%",
          overflowY: "auto",
          boxSizing: "border-box",
          color: "var(--dsw-alias-label-primary)",
        },
      },
        h("div", { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } },
          h("span", { style: { fontSize: 14, fontWeight: 600 } }, "Codex 桥"),
          h(Pill, {
            text: online ? "总线在线" : "总线未响应",
            color: online ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-state-error-primary)",
          }),
          h("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)" } },
            BUS.replace(/^https?:\/\//, "") + " · seq " + ((data && data.seq) || 0) + (data ? " · " + fmtClock(data.generatedAt) : "")),
          h("span", { style: { flex: "1 1 auto" } }),
          h("label", {
            style: { display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--dsw-alias-label-secondary)", cursor: "pointer" },
          },
            h("input", {
              type: "checkbox",
              checked: auto,
              onChange: function (e) { setAuto(!!e.target.checked); },
            }),
            "自动刷新"
          ),
          h("button", {
            type: "button",
            onClick: function () { load(); },
            style: {
              fontSize: 11,
              padding: "2px 10px",
              borderRadius: 6,
              cursor: "pointer",
              color: "var(--dsw-alias-label-primary)",
              background: "transparent",
              border: "1px solid var(--dsw-alias-border-l3)",
            },
          }, "刷新")
        ),

        snap.error
          ? h("div", { style: { marginTop: 8, fontSize: 11.5, color: "var(--dsw-alias-state-error-primary)" } },
              "总线未响应：" + snap.error + "（在窗口里运行 node dsh-codex-bridge/bus.mjs 起总线）")
          : null,

        h("div", { style: { marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap" } },
          peers.length === 0
            ? h(Empty, { text: "总线里还没有 peer。" })
            : peers.map(function (p) { return h(PeerCard, { key: p.peer, peer: p }); })
        ),

        projects.length === 0 ? null : h("section", { style: { marginTop: 20 } },
          h("div", { style: { display: "flex", alignItems: "baseline", gap: 8 } },
            label("按项目"),
            h("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)" } },
              "总线按 cwd 分组；推件用 --project 只看自己那组")
          ),
          h("div", { style: { marginTop: 6 } }, projects.map(function (p) {
            var folder = p.cwd ? String(p.cwd).split(/[\\/]/).filter(Boolean).pop() : "";
            return h("div", {
              key: p.id,
              style: {
                display: "flex",
                gap: 10,
                alignItems: "baseline",
                padding: "6px 0",
                borderBottom: "1px solid var(--dsw-alias-border-l3)",
              },
            },
              h("span", {
                style: { fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", fontSize: 11.5, color: "var(--dsw-alias-label-secondary)", width: 70, flex: "0 0 auto" },
              }, "#" + p.id),
              h("span", {
                style: { flex: "1 1 auto", minWidth: 0, fontSize: 12, color: "var(--dsw-alias-label-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
              }, folder || p.cwd || "(未知目录)"),
              h("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", flex: "0 0 auto" } },
                (p.sessions || 0) + " 会话 · " + (p.threads || 0) + " 线程"),
              p.unread ? h(Pill, { text: p.unread + " 未读", color: "var(--dsw-alias-state-warn-primary)" }) : null,
              // Codex's backlog is not ours: saying "unread" alone made people read it as work
              // waiting for this session, so the two sides are labelled separately.
              p.codexUnread ? h(Pill, { text: "codex " + p.codexUnread + " 未读", color: "var(--dsw-alias-label-secondary)" }) : null
            );
          }))
        ),

        h("section", { style: { marginTop: 20 } },
          h("div", { style: { display: "flex", alignItems: "baseline", gap: 8 } },
            label("最近消息"),
            h("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)" } }, recent.length ? "最新 " + recent.length + " 条" : "")
          ),
          recent.length === 0
            ? h(Empty, { text: "还没有消息。DSH 侧可以调 bridge_send，Codex 侧调 bridge_inbox。" })
            : h("div", { style: { marginTop: 6 } }, recent.map(function (m) {
                return h(MessageRow, { key: m.seq, message: m });
              }))
        ),

        h("section", { style: { marginTop: 20 } },
          h("div", { style: { display: "flex", alignItems: "baseline", gap: 8 } },
            label("Codex 线程"),
            h("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)" } }, "最近 4 小时有活动的")
          ),
          threads.length === 0
            ? h(Empty, { text: "最近 4 小时没有 Codex 线程活动。" })
            : h("div", { style: { marginTop: 6 } }, threads.map(function (t) {
                return h(ThreadRow, { key: t.id, thread: t });
              }))
        ),

        lanes.length === 0 ? null : h("section", { style: { marginTop: 20 } },
          label("定向车道"),
          h("div", { style: { marginTop: 6, fontSize: 11.5, color: "var(--dsw-alias-label-secondary)", lineHeight: "20px" } },
            lanes.map(function (key) {
              return h("div", { key: key, style: { fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace" } },
                String(key).replace("|", " @ ") + "  → " + data.lanes[key]);
            })
          )
        ),

        h("div", { style: { marginTop: 22, fontSize: 11, color: "var(--dsw-alias-label-caption)" } },
          "会话 " + sessionId.replace(/^session-/, "") +
          (data && data.dir ? "  ·  状态目录 " + data.dir : "") +
          "  ·  面板只读，不会替你 ack 任何消息"
        )
      );
    }

    // --- sidebar unread badge -------------------------------------------------
    // The View tab row cannot carry a count: conversation.view owns only { id, label },
    // label is a plain string capped at 88px, and the tabs are recomputed only when a
    // registration or the locale changes. The sidebar row is a list slot whose
    // occupants get their own sessionId and can subscribe to a store, so the count
    // lives there and stays live without re-registering (which would remount the tab).
    var BADGE_POLL_MS = 15000;

    function createBadgeStore() {
      var snapshot = {};
      var listeners = [];
      var timer = null;
      var inflight = false;
      var stopped = true;
      function publish(next) {
        if (JSON.stringify(snapshot) === JSON.stringify(next)) return;
        snapshot = next;
        for (var i = 0; i < listeners.length; i++) {
          try { listeners[i](); } catch (err) { /* a bad subscriber must not stop the rest */ }
        }
      }
      function read() {
        if (inflight) return;
        if (typeof document !== "undefined" && document.hidden) return;
        inflight = true;
        var ctrl = typeof AbortController === "function" ? new AbortController() : null;
        var guard = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (err) {} }, 4000) : 0;
        fetch(BUS + "/status", ctrl ? { signal: ctrl.signal } : undefined)
          .then(function (res) { return res.json(); })
          .then(function (raw) {
            if (!raw || typeof raw !== "object" || raw.ok === false) return;
            var lanes = raw.unreadLanes;
            if (!lanes || typeof lanes !== "object") return;
            var next = {};
            for (var key in lanes) {
              if (!Object.prototype.hasOwnProperty.call(lanes, key)) continue;
              var n = Number(lanes[key]) || 0;
              if (n > 0) next[key] = n;
            }
            publish(next);
          })
          .catch(function () { /* the badge keeps its last count instead of flashing away */ })
          .then(function () {
            if (guard) clearTimeout(guard);
            inflight = false;
          });
      }
      var self = {
        state: {
          getSnapshot: function () { return snapshot; },
          subscribe: function (listener) {
            listeners.push(listener);
            return function () {
              var at = listeners.indexOf(listener);
              if (at >= 0) listeners.splice(at, 1);
            };
          },
        },
        start: function () {
          if (!stopped) return;
          stopped = false;
          read();
          timer = setInterval(read, BADGE_POLL_MS);
        },
        stop: function () {
          stopped = true;
          if (timer) clearInterval(timer);
          timer = null;
        },
      };
      return self;
    }

    function UnreadBadge(props) {
      var counts = props.bridgeUnread || {};
      var n = Number(counts[props.sessionId]) || 0;
      if (!n) return null;
      return h("span", {
        title: "Codex 桥：" + n + " 条未读",
        style: {
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          minWidth: 16,
          height: 16,
          padding: "0 4px",
          marginLeft: 4,
          borderRadius: 8,
          fontSize: 10,
          fontWeight: 600,
          lineHeight: "16px",
          background: "var(--dsw-alias-state-warn-primary)",
          color: "var(--dsw-alias-bg-base)",
        },
      }, n > 99 ? "99+" : String(n));
    }

    function apply(ctx) {
      var labelText = function () {
        try {
          var active = ctx.locale.getLocale().active || "";
          return String(active).toLowerCase().indexOf("en") === 0 ? "Bridge" : "桥";
        } catch (err) {
          return "桥";
        }
      };
      ctx.slots.inject("conversation.view", function () {
        try {
          return ctx.slots.register({
            name: "conversation.view",
            id: "codex-bridge",
            order: 30,
            locale: NS,
            label: labelText,
            inject: function (sessionId) {
              return { sessionId: String(sessionId) };
            },
          }, BridgePanel);
        } catch (err) {
          console.warn("[codex-bridge] could not register the conversation view: " + err);
          return function () {};
        }
      });

      var badge = createBadgeStore();
      try {
        ctx.effect(function () {
          badge.start();
          return function () { badge.stop(); };
        });
      } catch (err) {
        console.warn("[codex-bridge] could not start the unread poller: " + err);
      }
      ctx.slots.inject("sidebar.session.row.trailing", function () {
        try {
          return ctx.slots.register({
            name: "sidebar.session.row.trailing",
            id: "codex-bridge-unread",
            order: 50,
            inject: function () { return { hooks: { bridgeUnread: badge.state } }; },
          }, UnreadBadge);
        } catch (err) {
          console.warn("[codex-bridge] could not register the unread badge: " + err);
          return function () {};
        }
      });
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale"];
    exports.BridgePanel = BridgePanel;
    exports.UnreadBadge = UnreadBadge;
    return module.exports;
  },
});
