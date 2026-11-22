// DSH client bundle: mobile-friendly account login, no desktop client required.
window.__ModuleLoader__.load({
  id: 'dsh-today-mobile',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const style = {
      panel: { maxWidth: 550, display: 'flex', flexDirection: 'column', gap: 14,
        paddingBottom: 28, color: 'var(--dsw-alias-label-primary)' },
      input: { width: '100%', boxSizing: 'border-box', minHeight: 42,
        borderRadius: 10, padding: '10px 12px', color: 'inherit',
        background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l2)' },
      button: { minHeight: 42, padding: '8px 16px', borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l2)', color: 'inherit',
        background: 'var(--dsw-alias-bg-base)', cursor: 'pointer' },
      note: { fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)' },
      error: { fontSize: 13, color: 'var(--dsw-alias-state-error-primary)' },
    };
    const call = async (ctx, method, args = {}) => {
      const res = await ctx.connection.rpc.call('/dsh-today-mobile-rpc', method, { args });
      if (!res || res.ok !== true) throw new Error(res?.error?.message || 'DSH 认证请求失败');
      return res.value;
    };
    function apply(ctx) {
      function Section() {
        const [status, setStatus] = React.useState(null);
        const [phone, setPhone] = React.useState('+86');
        const [otp, setOtp] = React.useState('');
        const [sent, setSent] = React.useState(false);
        const [busy, setBusy] = React.useState('');
        const [notice, setNotice] = React.useState('');
        const [error, setError] = React.useState('');
        const mounted = React.useRef(true);
        React.useEffect(() => {
          mounted.current = true;
          call(ctx, 'status').then(v => { if (mounted.current) setStatus(v); })
            .catch(e => { if (mounted.current) setError(e.message); });
          return () => { mounted.current = false; };
        }, []);
        async function run(label, task) {
          if (busy) return;
          setBusy(label); setNotice(''); setError('');
          try {
            const result = await task();
            if (!mounted.current) return;
            setStatus(result?.loggedIn === undefined ? status : result);
            setNotice(label + '成功');
          } catch (e) {
            if (mounted.current) setError(e?.message || String(e));
          } finally {
            if (mounted.current) setBusy('');
          }
        }
        return h('section', { style: style.panel },
          h('h3', { style: { margin: 0, fontSize: 19 } }, 'Today AI'),
          h('p', { style: style.note },
            '直接通过 Today 官网的手机号验证码登录，不需要电脑或桌面客户端。会话保存在 DSH 凭据中心，不会传给模型。'),
          status?.loggedIn
            ? h(React.Fragment, null,
                h('strong', null, '已连接 Today 账号'),
                h('p', { style: style.note }, '现在可在 DSH 模型选择器中选择 Today 提供的模型。'),
                h('button', { style: style.button, disabled: !!busy,
                  onClick: () => run('退出登录', () => call(ctx, 'logout')) }, '退出登录'))
            : h(React.Fragment, null,
                h('label', null, '手机号（包含国家区号）'),
                h('input', { style: style.input, type: 'tel', autoComplete: 'tel',
                  value: phone, disabled: !!busy, placeholder: '+8613800000000',
                  onChange: e => setPhone(e.target.value) }),
                h('button', { style: style.button, type: 'button', disabled: !!busy,
                  onClick: () => run('发送验证码', async () => {
                    await call(ctx, 'sendOtp', { phone: phone.trim() });
                    setSent(true);
                    return null;
                  }) }, sent ? '重新发送验证码（60秒后）' : '发送验证码'),
                sent && h(React.Fragment, null,
                  h('label', null, '短信验证码'),
                  h('input', { style: style.input, type: 'text', inputMode: 'numeric',
                    autoComplete: 'one-time-code', value: otp, disabled: !!busy,
                    placeholder: '输入收到的验证码',
                    onChange: e => setOtp(e.target.value) }),
                  h('button', { style: style.button, type: 'button', disabled: !!busy,
                    onClick: () => run('登录', () => call(ctx, 'verifyOtp',
                      { phone: phone.trim(), otp: otp.trim() })) }, '登录 Today'))),
          busy && h('p', { style: style.note, role: 'status' }, busy + '中…'),
          notice && h('p', { style: style.note, role: 'status' }, notice),
          error && h('p', { style: style.error, role: 'alert' }, error),
          h('p', { style: style.note },
            '注意：Today 云端目前没有原生工具调用及真正的流式输出；本插件继续使用原项目的文本工具模拟。账号额度以 Today 平台实际返回为准。')
        );
      }
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register({
          name: 'settings.section', id: 'today-ai', order: 18,
          label: () => 'Today AI',
        }, Section));
    }
    return { inject: ['slots', 'connection'], apply };
  },
});
