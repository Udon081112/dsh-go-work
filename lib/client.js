/**
 * dsh-go-work —— 客戶端半邊：DSH「設定」裡的 **瀏覽器** section
 *
 * 資料流：section ⇄ `/dsh-go-work/api/*`（同源 fetch）⇄ `~/.dsh/go-work.config.json`
 * 保存時提交整份設定，後端 merge，不會抹掉沒顯示的欄位。
 */
window.__ModuleLoader__.load({
  id: 'dsh-go-work',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const React = require('react');
    const { createElement: h, useCallback, useEffect, useState } = React;

    const API = '/dsh-go-work/api';
    const CSS_TAG = 'dsh-go-work/section.css';
    const CSS = [
      '.gw{max-width:780px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:6px}',
      '.gw-title{margin:0;font-size:16px;font-weight:500;line-height:24px}',
      '.gw-intro{color:var(--dsw-alias-label-tertiary);margin:0 0 4px;font-size:13px;line-height:20px}',
      '.gw-group{margin-top:16px;font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-secondary)}',
      '.gw-row{display:flex;gap:16px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--dsw-alias-line-subtle,rgba(128,128,128,.22))}',
      '.gw-label{flex:0 0 190px;font-size:13px;line-height:20px}',
      '.gw-hint{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin-top:2px}',
      '.gw-field{flex:1;display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.gw-input{width:100%;box-sizing:border-box;padding:5px 9px;font-size:13px;border-radius:6px;',
      'border:1px solid var(--dsw-alias-line-subtle,rgba(128,128,128,.3));background:transparent;color:inherit;font-family:inherit}',
      '.gw-ta{min-height:78px;resize:vertical;line-height:18px}',
      '.gw-check{display:flex;align-items:center;gap:8px;font-size:13px;line-height:20px}',
      '.gw-bar{display:flex;gap:10px;align-items:center;margin-top:18px;flex-wrap:wrap}',
      '.gw-btn{padding:0 12px;height:30px;font-size:12.5px;border-radius:6px;cursor:pointer;font-family:inherit;',
      'border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));background:transparent;color:var(--dsw-alias-label-primary)}',
      '.gw-btn:disabled{opacity:.5;cursor:default}',
      '.gw-btn-primary{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground,#fff);border-color:transparent}',
      '.gw-ok{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.gw-err{font-size:12px;color:var(--dsw-alias-label-error,#d33)}',
      '.gw-path{font-size:12px;color:var(--dsw-alias-label-tertiary);word-break:break-all;margin-top:6px}',
    ].join('\n');

    function ensureCss() {
      if (typeof document === 'undefined') return;
      if (document.getElementById(CSS_TAG)) return;
      const el = document.createElement('style');
      el.id = CSS_TAG;
      el.textContent = CSS;
      document.head.appendChild(el);
    }

    const FIELDS = [
      {
        group: '基本',
        path: 'enabled',
        label: '啟用瀏覽器工具',
        hint: '關掉之後，AI 看不到任何 browser 工具',
        kind: 'bool',
      },

      {
        group: 'Chrome',
        path: 'chromeProfile',
        label: '用哪個 Chrome',
        hint: '乾淨 profile 不帶你的登入態；「用現在這個」等於把自己交出去',
        kind: 'select',
        options: [
          ['clean', '乾淨（推薦）'],
          ['current', '用現在這個（帶登入態）'],
        ],
      },

      {
        group: '網域',
        path: 'domainPolicy',
        label: '政策',
        kind: 'select',
        options: [
          ['off', '不限制'],
          ['blocklist', '黑名單：禁止去這些'],
          ['allowlist', '白名單：只准去這些'],
        ],
      },
      {
        group: '網域',
        path: 'domainList',
        label: '清單',
        hint: '一行一個網域，例如 bilibili.com。白名單留空 = 哪都不能去。',
        kind: 'list',
      },

      {
        group: '敏感操作',
        path: 'guardPassword',
        label: '不准填密碼',
        hint: '輸入框 type=password 一律拒絕',
        kind: 'bool',
      },
      {
        group: '敏感操作',
        path: 'guardPayment',
        label: '不准碰付款',
        hint: '付款、結帳、送出訂單這類按鈕先擋',
        kind: 'bool',
      },
      {
        group: '預算',
        path: 'maxClicks',
        label: '最多點幾次',
        hint: '用完就停，避免它自己玩到失控',
        kind: 'number',
      },
      {
        group: '預算',
        path: 'maxMinutes',
        label: '最長幾分鐘',
        kind: 'number',
      },

      {
        group: '截圖',
        path: 'shotMode',
        label: '什麼時候給它看圖',
        hint: 'onDemand 最省：它要才給。interval 會一直燒 token。',
        kind: 'select',
        options: [
          ['onDemand', 'AI 自己要（推薦）'],
          ['interval', '每 N 秒自動給'],
          ['off', '完全關掉（只讀文字）'],
        ],
      },
      {
        group: '截圖',
        path: 'shotIntervalSec',
        label: '間隔秒數',
        kind: 'number',
      },
      {
        group: '截圖',
        path: 'shotDir',
        label: '存哪裡',
        hint: '留空 = 不存檔，只回給 AI 看',
        kind: 'text',
      },
    ];

    const TOOL_LABELS = {
      goto: 'goto — 開網頁',
      read: 'read — 讀頁面（元素清單帶 ref）',
      act: 'act — 點擊 / 輸入',
      shot: 'shot — 截圖',
      done: 'done — 宣告結束',
    };

    function Row(props) {
      return h(
        'div',
        { className: 'gw-row' },
        h(
          'div',
          { className: 'gw-label' },
          props.label,
          props.hint ? h('div', { className: 'gw-hint' }, props.hint) : null,
        ),
        h('div', { className: 'gw-field' }, props.children),
      );
    }

    function GoWorkSection() {
      const [cfg, setCfg] = useState(null);
      const [meta, setMeta] = useState(null);
      const [err, setErr] = useState('');
      const [busy, setBusy] = useState('');
      const [saved, setSaved] = useState('');

      const load = useCallback(async () => {
        setErr('');
        try {
          const res = await fetch(`${API}/config`, { credentials: 'same-origin' });
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || '讀取失敗');
          setCfg(data.config);
          setMeta({ configPath: data.configPath });
        } catch (e) {
          setErr(String(e?.message ?? e));
        }
      }, []);

      useEffect(() => {
        ensureCss();
        load();
      }, [load]);

      const save = useCallback(async () => {
        setBusy('save');
        setErr('');
        setSaved('');
        try {
          const res = await fetch(`${API}/config`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(cfg),
          });
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || '保存失敗');
          setCfg(data.config);
          setSaved('已保存');
        } catch (e) {
          setErr(String(e?.message ?? e));
        } finally {
          setBusy('');
        }
      }, [cfg]);

      if (!cfg) {
        return h('div', { className: 'gw' }, h('div', { className: 'gw-intro' }, err ? `讀取失敗：${err}` : '讀取中…'));
      }

      function setPath(key, value) {
        setCfg((prev) => ({ ...prev, [key]: value }));
        setSaved('');
      }

      function setTool(key, value) {
        setCfg((prev) => ({ ...prev, tools: { ...(prev.tools || {}), [key]: value } }));
        setSaved('');
      }

      function renderField(field) {
        const value = cfg[field.path];

        if (field.kind === 'bool') {
          return h(
            'label',
            { className: 'gw-check' },
            h('input', {
              type: 'checkbox',
              checked: !!value,
              onChange: (e) => setPath(field.path, e.target.checked),
            }),
            value ? '開' : '關',
          );
        }

        if (field.kind === 'select') {
          return h(
            'select',
            {
              className: 'gw-input',
              value: value ?? '',
              onChange: (e) => setPath(field.path, e.target.value),
            },
            field.options.map(([val, text]) => h('option', { key: val, value: val }, text)),
          );
        }

        if (field.kind === 'list') {
          return h('textarea', {
            className: 'gw-input gw-ta',
            value: (Array.isArray(value) ? value : []).join('\n'),
            placeholder: 'bilibili.com\nwww.zhihu.com',
            onChange: (e) =>
              setPath(
                field.path,
                e.target.value
                  .split('\n')
                  .map((s) => s.trim())
                  .filter(Boolean),
              ),
          });
        }

        if (field.kind === 'number') {
          return h('input', {
            className: 'gw-input',
            type: 'number',
            min: 0,
            value: Number.isFinite(value) ? value : 0,
            onChange: (e) => setPath(field.path, Number(e.target.value)),
          });
        }

        return h('input', {
          className: 'gw-input',
          type: 'text',
          value: value ?? '',
          onChange: (e) => setPath(field.path, e.target.value),
        });
      }

      const groups = [];
      for (const field of FIELDS) {
        let group = groups[groups.length - 1];
        if (!group || group.name !== field.group) {
          group = { name: field.group, rows: [] };
          groups.push(group);
        }
        group.rows.push(field);
      }

      return h(
        'div',
        { className: 'gw' },
        h('h3', { className: 'gw-title' }, 'AI瀏覽器'),
        h(
          'p',
          { className: 'gw-intro' },
          '讓 AI 自己開網頁、讀頁面、點東西。被政策擋下的動作不會執行，它會回頭問你。',
        ),

        groups.map((group) =>
          h(
            'div',
            { key: group.name },
            h('div', { className: 'gw-group' }, group.name),
            group.rows.map((field) =>
              h(Row, { key: field.path, label: field.label, hint: field.hint }, renderField(field)),
            ),
          ),
        ),

        h(
          'div',
          { key: 'tools' },
          h('div', { className: 'gw-group' }, '工具'),
          Object.keys(TOOL_LABELS).map((key) =>
            h(
              Row,
              { key, label: TOOL_LABELS[key] },
              h(
                'label',
                { className: 'gw-check' },
                h('input', {
                  type: 'checkbox',
                  checked: !!(cfg.tools && cfg.tools[key]),
                  onChange: (e) => setTool(key, e.target.checked),
                }),
                cfg.tools && cfg.tools[key] ? '開' : '關',
              ),
            ),
          ),
        ),

        h(
          'div',
          { className: 'gw-bar' },
          h(
            'button',
            { className: 'gw-btn gw-btn-primary', onClick: save, disabled: busy === 'save' },
            busy === 'save' ? '保存中…' : '保存',
          ),
          h('button', { className: 'gw-btn', onClick: load, disabled: !!busy }, '重新讀取'),
          saved ? h('span', { className: 'gw-ok' }, saved) : null,
          err ? h('span', { className: 'gw-err' }, err) : null,
        ),

        meta && meta.configPath
          ? h('div', { className: 'gw-path' }, `設定檔：${meta.configPath}`)
          : null,
      );
    }

    const inject = ['slots'];
    const NS = 'go-work';

    function apply(ctx) {
      ensureCss();
      ctx.effect(
        () =>
          ctx.slots.inject(
            'settings.section',
            () =>
              ctx.slots.register(
                { name: 'settings.section', id: NS, order: 7, label: () => 'AI瀏覽器' },
                GoWorkSection,
              ),
            'go-work: settings section',
          ),
        'go-work: settings section',
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.GoWorkSection = GoWorkSection;
    exports.FIELDS = FIELDS;
    return module.exports;
  },
});
