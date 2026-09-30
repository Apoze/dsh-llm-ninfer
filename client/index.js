window.__ModuleLoader__.load({
  id: 'dsh-llm-ninfer',
  factory: require => {
    const React = require('react');
    const h = React.createElement;
    const inject = ['slots', 'configForms', 'remote', 'remote.credentials'];
    const inputStyle = { width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid var(--dsw-border, #8885)', borderRadius: 6, background: 'var(--dsw-bg, transparent)', color: 'inherit', font: 'inherit' };
    const buttonStyle = { padding: '8px 12px', border: '1px solid var(--dsw-border, #8885)', borderRadius: 6, background: 'transparent', color: 'inherit', cursor: 'pointer' };
    const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 };
    const numeric = ['contentReserve', 'safetyMargin', 'compactionThreshold', 'requestTimeoutMs'];

    function normalize(draft) {
      const next = { ...draft, provider: draft.provider.trim(), baseURL: draft.baseURL.trim(), credentialRef: draft.credentialRef.trim() };
      if (!next.provider) throw new Error('Le fournisseur doit avoir un identifiant.');
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(next.credentialRef)) throw new Error('La référence de clé doit être un nom comme NINFER_API_KEY.');
      if (next.baseURL) {
        let url;
        try { url = new URL(next.baseURL); } catch { throw new Error('URL API invalide.'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Utiliser une URL HTTP(S) sans clé, identifiants, paramètres ou fragment.');
      }
      for (const field of numeric) {
        if (draft[field] === '') throw new Error('Les paramètres numériques doivent être renseignés.');
        next[field] = Number(draft[field]);
        if (!Number.isFinite(next[field])) throw new Error('Valeur numérique invalide.');
      }
      if (!Number.isInteger(next.contentReserve) || next.contentReserve < 1 || !Number.isInteger(next.safetyMargin) || next.safetyMargin < 0 || !Number.isInteger(next.requestTimeoutMs) || next.requestTimeoutMs < 1 || next.requestTimeoutMs > 2147483647 || next.compactionThreshold <= 0 || next.compactionThreshold > 1) throw new Error('Vérifier les limites numériques et le seuil de compaction (entre 0 exclu et 1).');
      next.models = draft.models.map(model => {
        const result = { id: model.id.trim(), contextWindow: Number(model.contextWindow) };
        if (!result.id || !Number.isInteger(result.contextWindow) || result.contextWindow < 1) throw new Error('Chaque modèle doit avoir un identifiant et un contexte entier positif.');
        if (model.name?.trim()) result.name = model.name.trim();
        if (model.maxTokens !== '' && model.maxTokens !== undefined) {
          result.maxTokens = Number(model.maxTokens);
          if (!Number.isInteger(result.maxTokens) || result.maxTokens < 1) throw new Error('La limite de sortie doit être un entier positif, ou rester vide.');
        }
        return result;
      });
      if (new Set(next.models.map(model => model.id)).size !== next.models.length) throw new Error('Les identifiants des modèles doivent être uniques.');
      return next;
    }

    function apply(ctx) {
      const form = ctx.configForms.get('llm-ninfer');
      const subscribe = listener => form.subscribe(listener);
      const getSnapshot = () => form.getSnapshot();

      function Credentials({ credentialRef, locked }) {
        const [info, setInfo] = React.useState(null);
        const [key, setKey] = React.useState('');
        const [busy, setBusy] = React.useState(false);
        const [message, setMessage] = React.useState('');
        const mounted = React.useRef(true);
        React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
        React.useEffect(() => {
          let alive = true;
          setInfo(null); setKey(''); setMessage('');
          ctx.remote.credentials.describe([credentialRef]).then(result => {
            if (!result.ok || !result.value[credentialRef]) throw new Error('Credential status unavailable');
            if (alive) setInfo(result.value[credentialRef]);
          }).catch(() => { if (alive) setMessage('Impossible de lire le statut de la clé. Recharger cette page pour réessayer.'); });
          return () => { alive = false; };
        }, [credentialRef]);
        async function saveKey(event) {
          event.preventDefault();
          if (!key || busy || locked) return;
          setBusy(true); setMessage('');
          try {
            const response = await ctx.remote.credentials.set(credentialRef, key);
            if (!response.ok) throw new Error('Credential write refused');
            if (!mounted.current) return;
            setKey('');
            const status = await ctx.remote.credentials.describe([credentialRef]);
            if (mounted.current) {
              setInfo(status.ok ? status.value[credentialRef] : { configured: true, writable: true });
              setMessage('Clé enregistrée dans les credentials DSH.');
            }
          } catch { if (mounted.current) setMessage('Enregistrement refusé. Vérifier que cette référence est modifiable dans les credentials DSH.'); }
          finally { if (mounted.current) setBusy(false); }
        }
        return h('form', { 'aria-label': 'Clé API', onSubmit: saveKey, style: { display: 'grid', gap: 10 } },
          h('h4', null, 'Clé API'),
          h('p', { role: 'status' }, info ? (info.configured ? 'Une clé est configurée pour ' : 'Aucune clé configurée pour ') + credentialRef + (info.writable ? '.' : ' (source en lecture seule).') : message ? 'Statut de la clé indisponible.' : 'Lecture du statut de la clé…'),
          h('label', null, 'Nouvelle clé API', h('input', { type: 'password', autoComplete: 'new-password', value: key, disabled: locked || busy || !info?.writable, onChange: event => setKey(event.target.value), style: inputStyle })),
          h('button', { type: 'submit', style: buttonStyle, disabled: locked || busy || !info?.writable || !key }, busy ? 'Enregistrement…' : 'Enregistrer la clé'),
          h('p', { style: { fontSize: 13, opacity: 0.8 } }, 'La clé existante n’est jamais affichée. Une nouvelle valeur la remplace pour cette référence. Laisser ce champ vide conserve la clé actuelle.'),
          message && h('p', { role: 'status' }, message));
      }

      function Editor({ snapshot }) {
        const [base, setBase] = React.useState(snapshot);
        const [draft, setDraft] = React.useState(() => structuredClone(snapshot.value));
        const [busy, setBusy] = React.useState(false);
        const [message, setMessage] = React.useState(null);
        const mounted = React.useRef(true);
        React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
        const dirty = JSON.stringify(draft) !== JSON.stringify(base.value);
        const stale = snapshot.revision !== base.revision;
        const locked = busy || !snapshot.writable;
        function reload() { setBase(snapshot); setDraft(structuredClone(snapshot.value)); setMessage(null); }
        function field(key, label, options = {}) {
          return h('label', { key }, label, h('input', { ...options, style: inputStyle, value: draft[key] ?? '', onChange: event => setDraft(previous => ({ ...previous, [key]: event.target.value })) }));
        }
        async function save(event) {
          event.preventDefault();
          if (locked || stale) return;
          let next;
          try { next = normalize(draft); } catch (error) { setMessage({ error: true, text: error.message }); return; }
          setBusy(true); setMessage(null);
          try {
            const accepted = await form.mutate(Object.entries(next).map(([key, value]) => ({ op: 'set', path: [key], value })), base.revision);
            if (!mounted.current) return;
            if (accepted) {
              const current = form.getSnapshot();
              setBase(current); setDraft(structuredClone(current.value));
              setMessage({ error: false, text: 'Configuration enregistrée. Elle s’applique aux nouveaux appels.' });
            } else setMessage({ error: true, text: 'Configuration refusée ou modifiée ailleurs. Recharger les valeurs avant de réessayer.' });
          } catch { if (mounted.current) setMessage({ error: true, text: 'Impossible d’enregistrer la configuration. Vérifier la connexion à DSH.' }); }
          finally { if (mounted.current) setBusy(false); }
        }
        return h('div', { style: { display: 'grid', gap: 22, maxWidth: 850 } },
          h('h4', null, 'Configuration NInfer'),
          h('p', null, 'Ces réglages sont enregistrés dans le profil DSH ouvert. Les clés restent dans le gestionnaire de credentials.'),
          (!base.value.baseURL || !base.value.models.length) && h('p', { role: 'status' }, 'Connexion à compléter : aucun fournisseur NInfer n’est enregistré tant que l’URL et au moins un modèle ne sont pas renseignés.'),
          stale && h('p', { role: 'alert' }, 'La configuration a changé ailleurs. Recharger les valeurs avant de les modifier.'),
          !snapshot.writable && h('p', { role: 'alert' }, 'Configuration en lecture seule. Ouvrir DSH depuis son raccourci local pour la modifier.'),
          h('form', { onSubmit: save }, h('fieldset', { disabled: locked, style: { border: 0, padding: 0, display: 'grid', gap: 18 } },
            h('div', { style: grid },
              field('baseURL', 'URL de base API', { type: 'url', placeholder: 'http://localhost:8000/v1' }),
              field('provider', 'Identifiant du fournisseur', { required: true }),
              field('credentialRef', 'Référence de clé API', { required: true, pattern: '[A-Za-z_][A-Za-z0-9_]*' })),
            h('h4', null, 'Modèles'),
            draft.models.map((model, index) => {
              const modelField = (key, label, options = {}) => h('label', { key }, label, h('input', { ...options, style: inputStyle, value: model[key] ?? '', onChange: event => setDraft(previous => ({ ...previous, models: previous.models.map((item, at) => at === index ? { ...item, [key]: event.target.value } : item) })) }));
              return h('fieldset', { key: index, style: { border: '1px solid #8885', borderRadius: 8, padding: 14 } },
                h('legend', null, 'Modèle ' + (index + 1)),
                h('div', { style: grid }, modelField('id', 'Identifiant exact du modèle', { required: true }), modelField('name', 'Nom affiché'), modelField('contextWindow', 'Fenêtre de contexte (tokens)', { type: 'number', min: 1, step: 1, required: true }), modelField('maxTokens', 'Limite de sortie (optionnelle)', { type: 'number', min: 1, step: 1 })),
                h('button', { type: 'button', style: { ...buttonStyle, marginTop: 12 }, onClick: () => setDraft(previous => ({ ...previous, models: previous.models.filter((_, at) => at !== index) })) }, 'Retirer ce modèle'));
            }),
            h('button', { type: 'button', style: buttonStyle, onClick: () => setDraft(previous => ({ ...previous, models: [...previous.models, { id: '', contextWindow: 131072 }] })) }, 'Ajouter un modèle'),
            h('h4', null, 'Budget et délais'),
            h('div', { style: grid }, field('contentReserve', 'Réserve de contenu (tokens)', { type: 'number', min: 1, step: 1, required: true }), field('safetyMargin', 'Marge de sécurité (tokens)', { type: 'number', min: 0, step: 1, required: true }), field('compactionThreshold', 'Seuil de compaction (ratio)', { type: 'number', min: 0.000001, max: 1, step: 'any', required: true }), field('requestTimeoutMs', 'Délai maximal (millisecondes)', { type: 'number', min: 1, max: 2147483647, step: 1, required: true })),
            h('p', { style: { fontSize: 13, opacity: 0.8 } }, 'Le serveur reste la référence pour le comptage des tokens. Le niveau de raisonnement se choisit dans le sélecteur de modèle de DSH. Les autres politiques de compaction appartiennent au preset de l’agent.'),
            h('div', { style: { display: 'flex', gap: 10 } }, h('button', { type: 'submit', style: buttonStyle, disabled: !dirty || stale }, busy ? 'Enregistrement…' : 'Enregistrer la configuration'), h('button', { type: 'button', style: buttonStyle, onClick: reload }, 'Recharger les valeurs')))),
          message && h('p', { role: message.error ? 'alert' : 'status' }, message.text),
          h(Credentials, { key: base.value.credentialRef, credentialRef: base.value.credentialRef, locked: locked || dirty || stale }),
          dirty && h('p', null, 'Enregistrer ou recharger la configuration avant de modifier la clé.'));
      }

      function Page() {
        const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
        if (snapshot.status !== 'ready' || !snapshot.value) return h('p', { role: 'status' }, 'Activer le composant NInfer pour configurer sa connexion. Les valeurs vides sont acceptées pendant la configuration.');
        return h(Editor, { snapshot });
      }
      ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', id: 'dsh-llm-ninfer', key: 'dsh-llm-ninfer' }, Page)), 'ninfer: native configuration page');
    }
    return { inject, apply };
  },
});
