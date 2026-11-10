// Client 半：在每一轮的末尾（「已完成 · 用时」那一行下面）直接显示这一轮的耗时去向。
//
// 数据只来自浏览器侧已经收到的会话事件（ctx.sessions.binding(id).eventSource），
// 不请求宿主、不写日志、不消耗模型 token。
//
// 手写 lazy-CJS bundle：脚本执行时只注册 factory，模块体在 materialize 时才运行。
window.__ModuleLoader__.load({
  id: "@skyrocks/dsh-turn-timing",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

    // ───────────────────────────────────────────────────────────
    // 分类规则：从上到下第一个命中的赢。
    // 想改口径（比如把 mvn clean verify 算测试）就改这里。
    // ───────────────────────────────────────────────────────────
    const RULES = [
      ["测试", "命令测试", /\b(pytest|vitest|jest|mocha|ava|phpunit|go test|cargo test|npm (run )?test|pnpm (run )?test|yarn (run )?test|make test|mvn\b[^|;&]*\b(test|verify)\b|gradle\w*\b(test|check)\b)\b/i],
      ["测试", "浏览器", /\b(playwright|puppeteer|selenium|cypress|webdriver)\b/i],
      ["构建", "构建", /\b(tsc\b|vite build|webpack|rollup|esbuild|next build|cargo build|go build|mvn\b[^|;&]*\b(package|install|compile)\b|gradle\w*\b(build|assemble)\b|docker build)\b/i],
      ["构建", "安装", /\b(pnpm (install|i|add)|npm (i|install|ci)|yarn install|pip3? install|poetry install|brew install|gem install)\b/i],
      ["构建", "静态检查", /\b(eslint|prettier|ruff|mypy|pyright|flake8|pylint|tsc --noEmit|cargo clippy|golangci-lint)\b/i],
      ["清理", "还原", /(git (checkout|restore|stash|reset)\b|docker (stop|rm|kill)\b|(npm|pnpm|yarn) run clean\b|make clean\b)/i],
      ["清理", "临时文件", /\brm\s+(-[a-zA-Z]+\s+)*[^\s]*(\/tmp\/|\.log\b|\.tmp\b)/i],
      ["清理", "进程", /\b(kill|pkill|killall)\b/i],
      ["编码", "编辑", /(\bsed -i\b|\bcat >>?\s|\btee\s|\bpatch\s|\bgit apply\b)/i],
      ["编码", "git", /\bgit\s+(status|diff|log|show|add|commit|branch|remote|fetch|stash list)\b/i],
      ["编码", "搜索", /\b(rg|ag|ack|grep|find)\b/i],
      ["编码", "看文件", /\b(cat|head|tail|less|more|wc|nl|file|stat|tree)\b/i],
      ["编码", "脚本", /\b(node|deno|tsx|ts-node|python3?|bash|sh|zsh|ruby|perl|npx)\b/i],
      ["编码", "目录", /\b(cd|pwd|ls|mkdir|rmdir|du|df|dirname|basename)\b/i],
    ];

    const ROW_ORDER = ["模型", "编码", "构建", "测试", "清理"];
    const MAX_SUBS = 3;
    const SUB_LIMIT = { 编码: 6 };
    const MIN_ROW_MS = 1000;
    const EMPTY_REPORT = new Map();

    // ───────────────────────────────────────────────────────────
    // 纯计算
    // ───────────────────────────────────────────────────────────

    function toEvents(entries) {
      const out = [];
      for (const entry of entries || []) {
        const event = entry && entry.event ? entry.event : entry;
        if (event && typeof event.type === "string") out.push(event);
      }
      return out;
    }

    function sum(list) {
      let total = 0;
      for (const value of list) total += value;
      return total;
    }

    /** 一段 packed run 的起止：time0 是第一个 delta，dt 是后续每个的间隔。 */
    function runSpan(records, kind) {
      let min = Infinity;
      let max = -Infinity;
      for (const record of records) {
        if (record.type !== kind) continue;
        const start = record.time0;
        const end = record.time0 + sum(record.dt || []);
        if (start < min) min = start;
        if (end > max) max = end;
      }
      return max > min ? max - min : 0;
    }

    function firstChunkTime(records) {
      const first = records[0];
      if (!first) return undefined;
      return first.type === "chunk" ? first.time : first.time0;
    }

    function classify(name, args) {
      if (name === "read_image") return ["测试", "识图"];
      let text = "";
      if (typeof args === "string") text = args;
      else if (args) text = JSON.stringify(args);
      for (const [category, sub, pattern] of RULES) {
        if (pattern.test(text)) return [category, sub];
      }
      if (name === "edit" || name === "write" || name === "notebook_edit") return ["编码", "编辑"];
      if (name === "read") return ["编码", "看文件"];
      if (name === "grep" || name === "glob") return ["编码", "搜索"];
      return ["编码", "其他命令"];
    }

    function bucketOf(buckets, name) {
      let bucket = buckets.get(name);
      if (bucket === undefined) {
        bucket = { ms: 0, subs: new Map() };
        buckets.set(name, bucket);
      }
      return bucket;
    }

    function addTo(buckets, name, sub, ms) {
      const bucket = bucketOf(buckets, name);
      bucket.ms += ms;
      bucket.subs.set(sub, (bucket.subs.get(sub) || 0) + ms);
    }

    /**
     * 把一段会话事件折成「轮次 → 耗时去向」。
     * @param entries eventSource 窗口里的条目（{ seq, event } 或裸事件）
     * @returns Map<turn, report>
     */
    function analyze(entries) {
      const events = toEvents(entries);
      if (events.length === 0) return EMPTY_REPORT;

      const stepStarts = new Map();
      for (const event of events) {
        if (event.type === "step/start" && event.data) {
          stepStarts.set(`${event.data.turn}/${event.data.step}`, event.time);
        }
      }

      // 同一 callId 在 fork/重放里会出现多次：配最近的那次（后进先出），
      // 否则会配到很久以前的旧记录，算出「一次 read 用了 25 小时」这种假数。
      // 超过 1 小时的配对一律丢弃——正常工具调用不会那么久。
      const pending = new Map();
      const calls = [];
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        const data = event.data || {};
        if (event.type === "tool/call") {
          const list = pending.get(data.callId);
          const call = { index, time: event.time, name: data.name, args: data.arguments, turn: data.turn };
          if (list === undefined) pending.set(data.callId, [call]);
          else list.push(call);
        } else if (event.type === "tool/result") {
          const id = data.message && data.message.toolCallId;
          const list = pending.get(id);
          if (list === undefined || list.length === 0) continue;
          const call = list.pop();
          const duration = event.time - call.time;
          if (!(duration >= 0) || duration > 3600000) continue;
          calls.push(Object.assign({}, call, { resultIndex: index, duration }));
        }
      }

      const turns = new Map();
      const turnState = (turn) => {
        let state = turns.get(turn);
        if (state === undefined) {
          state = { turn, start: null, end: null, model: [], calls: [] };
          turns.set(turn, state);
        }
        return state;
      };

      let lastTime = 0;
      for (const event of events) {
        const data = event.data || {};
        if (event.time > lastTime) lastTime = event.time;
        if (event.type === "turn/start") {
          const state = turnState(data.turn);
          if (state.start === null) state.start = event.time;
        } else if (event.type === "turn/end") {
          turnState(data.turn).end = event.time;
        }
      }

      const messages = new Map();
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        if (event.type !== "assistant/message" || !event.data) continue;
        const start = stepStarts.get(`${event.data.turn}/${event.data.step}`);
        if (start === undefined) continue;
        const stream = event.data.stream || [];
        const first = firstChunkTime(stream);
        const item = {
          index,
          ms: event.time - start,
          ttft: first === undefined ? 0 : Math.max(0, first - start),
          reasoning: runSpan(stream, "reasoning-chunks"),
          text: runSpan(stream, "text-chunks"),
          vision: false,
        };
        turnState(event.data.turn).model.push(item);
        messages.set(index, item);
      }

      // 识图：截图本身不耗时，慢的是之后那次模型调用。多张截图合并到同一次调用只算一次。
      const messageIndexes = [...messages.keys()].sort((a, b) => a - b);
      for (const call of calls) {
        if (call.name !== "read_image") continue;
        let next;
        for (const index of messageIndexes) {
          if (index > call.resultIndex) {
            next = index;
            break;
          }
        }
        if (next === undefined) continue;
        messages.get(next).vision = true;
      }

      for (const call of calls) {
        const state = turnState(call.turn);
        const [category, sub] = classify(call.name, call.args);
        call.category = category;
        call.sub = sub;
        state.calls.push(call);
      }

      const report = new Map();
      for (const state of turns.values()) {
        if (state.start === null) continue;
        if (state.model.length === 0 && state.calls.length === 0) continue;

        const buckets = new Map();
        const model = { ms: 0, ttft: 0, reasoning: 0, text: 0, visionMs: 0 };
        for (const item of state.model) {
          model.ms += item.ms;
          model.ttft += item.ttft;
          model.reasoning += item.reasoning;
          model.text += item.text;
          if (item.vision) model.visionMs += item.ms;
        }
        if (state.model.length > 0) {
          const bucket = bucketOf(buckets, "模型");
          bucket.ms = model.ms;
          bucket.subs.set("等首字", model.ttft);
          bucket.subs.set("思考", model.reasoning);
          bucket.subs.set("输出", model.text);
        }

        let visionCount = 0;
        for (const call of state.calls) {
          if (call.sub === "识图") visionCount += 1;
          addTo(buckets, call.category, call.sub, call.duration);
        }
        if (model.visionMs > 0) addTo(buckets, "测试", "识图", model.visionMs);

        const open = state.end === null;
        report.set(state.turn, {
          turn: state.turn,
          total: Math.max(0, (open ? lastTime : state.end) - state.start),
          open,
          visionCount,
          model,
          buckets,
        });
      }
      return report;
    }

    // ───────────────────────────────────────────────────────────
    // 格式化
    // ───────────────────────────────────────────────────────────

    function format(ms) {
      if (typeof ms !== "number" || ms < 0) return "—";
      if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
      const seconds = Math.round(ms / 1000);
      if (seconds < 60) return `${seconds}s`;
      const minutes = Math.floor(seconds / 60);
      const rest = seconds % 60;
      if (minutes < 60) return `${minutes}m${String(rest).padStart(2, "0")}s`;
      return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
    }

    function rowsOf(report) {
      const rows = [];
      for (const name of ROW_ORDER) {
        const bucket = report.buckets.get(name);
        if (bucket === undefined || bucket.ms < MIN_ROW_MS) continue;
        const subs = [...bucket.subs.entries()]
          .filter(([, ms]) => ms >= MIN_ROW_MS)
          .sort((a, b) => b[1] - a[1])
          .slice(0, SUB_LIMIT[name] || MAX_SUBS);
        rows.push({ name, ms: bucket.ms, subs });
      }
      return rows;
    }

    function verdictOf(rows) {
      let top;
      for (const row of rows) if (top === undefined || row.ms > top.ms) top = row;
      if (top === undefined) return "";
      const sub = top.subs[0];
      const dominant = sub !== undefined && top.ms > 0 && sub[1] / top.ms > 0.6;
      return dominant ? `慢在${top.name}（${sub[0]}）` : `慢在${top.name}`;
    }

    // ───────────────────────────────────────────────────────────
    // 每会话一份折叠结果，按 revision 节流重算
    // ───────────────────────────────────────────────────────────

    let ctxRef;
    const stores = new WeakMap();

    function storeFor(binding) {
      const cached = stores.get(binding);
      if (cached !== undefined) return cached;
      let revision = -1;
      let data = EMPTY_REPORT;
      let timer;
      const listeners = new Set();
      const publish = () => {
        data = analyze(binding.eventSource.getSnapshot().entries);
        for (const listener of listeners) listener();
      };
      const refresh = () => {
        const snapshot = binding.eventSource.getSnapshot();
        if (snapshot.revision === revision) return;
        revision = snapshot.revision;
        if (timer !== undefined) return;
        timer = setTimeout(() => {
          timer = undefined;
          publish();
        }, 250);
      };
      const stop = binding.eventSource.subscribe(refresh);
      binding.ctx.effect(() => () => {
        stop();
        if (timer !== undefined) clearTimeout(timer);
        stores.delete(binding);
      }, "dsh-turn-timing: report store");
      const store = {
        getSnapshot: () => data,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      stores.set(binding, store);
      publish();
      return store;
    }

    function useStore(store) {
      const [value, setValue] = React.useState(() => (store ? store.getSnapshot() : EMPTY_REPORT));
      React.useEffect(() => {
        if (store === undefined) return undefined;
        setValue(store.getSnapshot());
        return store.subscribe(() => setValue(store.getSnapshot()));
      }, [store]);
      return value;
    }

    // ───────────────────────────────────────────────────────────
    // 组件
    // ───────────────────────────────────────────────────────────

    const COLORS = {
      模型: "var(--dsh-tt-model)",
      编码: "var(--dsh-tt-code)",
      构建: "var(--dsh-tt-build)",
      测试: "var(--dsh-tt-test)",
      清理: "var(--dsh-tt-clean)",
    };

    function colorOf(name) {
      return COLORS[name] || "var(--dsw-alias-label-tertiary, #8a8f98)";
    }

    function Bar({ rows, width }) {
      const total = rows.reduce((sum, row) => sum + row.ms, 0) || 1;
      return React.createElement(
        "span",
        { className: "dsh-tt-bar", style: width === undefined ? undefined : { width } },
        rows.map((row) =>
          React.createElement("span", {
            key: row.name,
            className: "dsh-tt-seg",
            style: { width: Math.max(2, (row.ms / total) * 100) + "%", background: colorOf(row.name) },
          }),
        ),
      );
    }

    function Dot({ name }) {
      return React.createElement("span", { className: "dsh-tt-dot", style: { background: colorOf(name) } });
    }

    function Hint({ text }) {
      return React.createElement(
        "div",
        { className: "dsh-tt-root dsh-tt-hint" },
        React.createElement("span", { className: "dsh-tt-clock", "aria-hidden": "true" }, "◷"),
        " 计时：",
        text,
      );
    }

    /** 槽位传进来的 turn 是对话的 Turn 对象（{ turn, start, end, steps }），不是数字。 */
    function turnNumberOf(value) {
      if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
      if (value === null || typeof value !== "object") return undefined;
      if (typeof value.turn === "number") return value.turn;
      return undefined;
    }

    /** 窗口里最后一轮是哪一轮、有没有已经结束的轮次（运行中的轮次不该急着报错）。 */
    function windowFacts(binding) {
      try {
        const entries = binding.eventSource.getSnapshot().entries || [];
        let closed = false;
        let lastTurn;
        for (const entry of entries) {
          const event = entry && entry.event ? entry.event : entry;
          if (event === undefined || event === null) continue;
          if (event.type === "turn/end") closed = true;
          const value = event.data === undefined || event.data === null ? undefined : event.data.turn;
          if (typeof value === "number" && (lastTurn === undefined || value > lastTurn)) lastTurn = value;
        }
        return { closed, lastTurn };
      } catch (error) {
        return { closed: true, lastTurn: undefined };
      }
    }

    /** 解析这一轮所属的会话绑定；任何一步失败都返回一句可读的原因。 */
    function resolve(props) {
      try {
        const sessionId = props === undefined ? undefined : props.sessionId;
        if (sessionId === undefined) return { problem: "槽位没有传 sessionId" };
        const sessions = ctxRef === undefined ? undefined : ctxRef.get("sessions");
        if (sessions === undefined) return { problem: "sessions 服务不可用" };
        const binding = sessions.binding(sessionId);
        if (binding === undefined) return { problem: "会话未绑定" };
        return { binding, store: storeFor(binding) };
      } catch (error) {
        return { problem: `初始化失败：${(error && error.message) || String(error)}` };
      }
    }

    function TurnTiming(props) {
      const resolved = resolve(props);
      const report = useStore(resolved.store);
      const [open, setOpen] = React.useState(false);

      if (resolved.problem !== undefined) return React.createElement(Hint, { text: resolved.problem });

      const turn = turnNumberOf(props === undefined ? undefined : props.turn);
      const data = turn === undefined ? undefined : report.get(turn);

      if (data === undefined) {
        if (turn === undefined) return null;
        const facts = windowFacts(resolved.binding);
        if (!facts.closed) return null;
        if (facts.lastTurn !== undefined && facts.lastTurn !== turn) return null;
        let count = 0;
        try {
          count = resolved.binding.eventSource.getSnapshot().entries.length;
        } catch (error) {
          count = -1;
        }
        return React.createElement(Hint, { text: `第 ${turn} 轮暂无数据（窗口内 ${count} 条事件）` });
      }

      const rows = rowsOf(data);
      if (rows.length === 0) {
        return React.createElement(Hint, { text: `第 ${turn} 轮没有可归类的耗时（总 ${format(data.total)}）` });
      }
      const verdict = verdictOf(rows);

      const head = React.createElement(
        "button",
        {
          type: "button",
          className: "dsh-tt-head",
          "aria-expanded": open,
          onClick: () => setOpen((value) => !value),
        },
        React.createElement("span", { className: "dsh-tt-clock", "aria-hidden": "true" }, "◷"),
        React.createElement("span", { className: "dsh-tt-label" }, "耗时"),
        React.createElement("span", { className: "dsh-tt-total" }, `${data.open ? "进行中 " : ""}${format(data.total)}`),
        React.createElement("span", { className: "dsh-tt-divider", "aria-hidden": "true" }, "|"),
        React.createElement(
          "span",
          { className: "dsh-tt-chips" },
          rows.map((row, index) =>
            React.createElement(React.Fragment, { key: row.name },
              index > 0 ? React.createElement("span", { className: "dsh-tt-sep", "aria-hidden": "true" }, "·") : null,
              React.createElement("span", { className: "dsh-tt-chip" },
                React.createElement(Dot, { name: row.name }),
                row.name + " ",
                React.createElement("b", null, format(row.ms)),
              ),
            ),
          ),
        ),
        verdict === ""
          ? null
          : React.createElement(React.Fragment, null,
              React.createElement("span", { className: "dsh-tt-divider", "aria-hidden": "true" }, "|"),
              React.createElement("span", { className: "dsh-tt-verdict" }, verdict),
            ),
        React.createElement("span", { className: "dsh-tt-caret", "aria-hidden": "true" }, open ? "▴" : "▾"),
      );

      if (!open) return React.createElement("div", { className: "dsh-tt-root" }, head);

      const total = rows.reduce((sum, row) => sum + row.ms, 0) || 1;
      const cells = [];
      for (const row of rows) {
        cells.push(
          React.createElement("span", { className: "dsh-tt-name", key: row.name + ":n" },
            React.createElement(Dot, { name: row.name }),
            row.name,
          ),
          React.createElement("span", { className: "dsh-tt-ms", key: row.name + ":t" }, format(row.ms)),
          React.createElement("span", { className: "dsh-tt-bar", key: row.name + ":b" },
            React.createElement("span", {
              className: "dsh-tt-seg",
              style: { width: Math.max(3, (row.ms / total) * 100) + "%", background: colorOf(row.name) },
            }),
          ),
          React.createElement("span", { className: "dsh-tt-sub", key: row.name + ":s" },
            row.subs.length === 0
              ? React.createElement("span", { className: "dsh-tt-muted" }, "—")
              : row.subs.map((sub, index) =>
                  React.createElement(React.Fragment, { key: sub[0] },
                    index > 0 ? React.createElement("span", { className: "dsh-tt-sep", "aria-hidden": "true" }, "·") : null,
                    React.createElement("span", { className: "dsh-tt-chip" },
                      sub[0] + (sub[0] === "识图" ? "*" : ""),
                      " ",
                      format(sub[1]),
                    ),
                  ),
                ),
          ),
        );
      }
      if (data.visionCount > 0) {
        cells.push(React.createElement("span", { className: "dsh-tt-note", key: "note" }, "* 识图含模型读图时间（与「模型」重叠）"));
      }

      return React.createElement("div", { className: "dsh-tt-root" }, head, React.createElement("div", { className: "dsh-tt-body" }, cells));
    }

    // ───────────────────────────────────────────────────────────
    // 样式
    // ───────────────────────────────────────────────────────────

    const CSS = [
      ".dsh-tt-root{--dsh-tt-model:#5b74e0;--dsh-tt-code:#4aa87a;--dsh-tt-build:#c68a4a;--dsh-tt-test:#bf6577;--dsh-tt-clean:#9aa0a8;display:flex;flex-direction:column;gap:6px;margin:8px 0 4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8f98);font-variant-numeric:tabular-nums;user-select:text}",
      ".dsh-tt-head{display:flex;align-items:center;gap:8px;max-width:100%;padding:1px 0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;flex-wrap:wrap;border-radius:6px}",
      ".dsh-tt-head:hover{color:var(--dsw-alias-label-secondary,#6b7280)}",
      ".dsh-tt-head:hover .dsh-tt-caret{opacity:.8}",
      ".dsh-tt-head:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:3px}",
      ".dsh-tt-clock{opacity:.6;font-size:16px;line-height:1;display:inline-flex;align-items:center;margin-right:-3px;transform:translateY(-1px)}",
      ".dsh-tt-label{font-size:11px;opacity:.65;margin-right:-3px}",
      ".dsh-tt-divider{opacity:.22;font-weight:400;margin:0 1px}",
      ".dsh-tt-total{font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary,#6b7280);letter-spacing:.01em}",
      ".dsh-tt-bar{display:inline-flex;flex:none;width:44px;height:3px;border-radius:999px;overflow:hidden;background:transparent;opacity:.55}",
      ".dsh-tt-seg{display:block;height:100%}",
      ".dsh-tt-chips{display:flex;align-items:center;min-width:0;flex-wrap:wrap}",
      ".dsh-tt-chip{white-space:nowrap}",
      ".dsh-tt-chip b{font-weight:500;color:var(--dsw-alias-label-secondary,#6b7280)}",
      ".dsh-tt-dot{display:inline-block;width:5px;height:5px;border-radius:50%;margin-right:5px;vertical-align:middle;opacity:.9}",
      ".dsh-tt-sep{padding:0 6px;opacity:.3}",
      ".dsh-tt-verdict{font-size:11px;opacity:.85}",
      ".dsh-tt-caret{opacity:.4;font-size:9px;line-height:1}",
      ".dsh-tt-body{display:grid;grid-template-columns:3.1em 4.4em 44px minmax(0,1fr);align-items:center;column-gap:10px;row-gap:6px;padding:10px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05))}",
      ".dsh-tt-name{display:flex;align-items:center;font-size:11.5px;white-space:nowrap}",
      ".dsh-tt-ms{text-align:right;font-weight:500;color:var(--dsw-alias-label-secondary,#6b7280)}",
      ".dsh-tt-body .dsh-tt-bar{width:44px;height:3px;opacity:1;background:var(--dsw-alias-border-l1,rgba(127,127,127,.1))}",
      ".dsh-tt-sub{min-width:0;white-space:normal;word-break:keep-all;font-size:11px;line-height:17px;opacity:.85}",
      ".dsh-tt-note{grid-column:1/-1;padding-top:2px;font-size:10.5px;opacity:.45}",
      ".dsh-tt-muted{opacity:.5}",
      ".dsh-tt-hint{opacity:.6;font-size:11px}",
    ].join("");

    function ensureStyle() {
      if (typeof document === "undefined") return () => {};
      const id = "dsh-turn-timing-style";
      if (document.getElementById(id) !== null) return () => {};
      const element = document.createElement("style");
      element.id = id;
      element.textContent = CSS;
      document.head.appendChild(element);
      return () => {
        element.remove();
      };
    }

    // ───────────────────────────────────────────────────────────
    // 装配
    // ───────────────────────────────────────────────────────────

    function apply(ctx) {
      ctxRef = ctx;
      const slots = ctx.get("slots");
      if (slots === undefined) return;
      ctx.effect(() => ensureStyle());
      slots.inject("conversation.chat.turnTail", () =>
        slots.register(
          { name: "conversation.chat.turnTail", id: "turn-timing", order: 20 },
          TurnTiming,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = ["slots", "sessions"];
    exports.__internals = { analyze, classify, format, rowsOf, verdictOf, turnNumberOf, CSS };
    return module.exports;
  },
});
