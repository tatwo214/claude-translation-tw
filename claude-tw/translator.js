/* Runs in Electron's isolated preload world. No network, page globals, or HTML writes. */
function installClaudeTW(bridge) {
  'use strict';
  const ATTRS = ['aria-label', 'title', 'placeholder', 'alt'];
  const CONTEXT_ATTRS = ['class','role','contenteditable','href','id','aria-checked','aria-current','hidden','aria-hidden','data-testid','data-is-streaming','data-session-id','data-claude-tw-private'];
  const normalize = s => String(s || '').replace(/\s+/g, ' ').trim();
  const replaceLabel = (source, target) =>
    (source.match(/^\s*/)?.[0] || '') + target + (source.match(/\s*$/)?.[0] || '');
  const excluded = 'script,style,svg,img,[role="treeitem"],[data-testid*="file-name" i],code,pre,samp,kbd,textarea,input,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[data-is-streaming],[data-testid*="message" i],[data-testid*="conversation" i],[data-testid*="session-title" i],[data-testid*="project-name" i],[data-testid*="file-name" i],[class*="monaco"],[class*="cm-editor"],[data-claude-tw-private]';
  function isPrivate(el) {
    if (el.closest(excluded)) return true;
    // Verified Code renderer markers: protect virtualized turns/tool output,
    // session rows/tiles and user-selected titles even without semantic classes.
    if (el.closest('[data-testid^="transcript-"],[data-session-id],[data-testid="chat-title-standin"],[data-testid="rail-preset-name"],[data-testid="name-chat"]')) return true;
    for (let p = el; p; p = p.parentElement) {
      // Tailwind layout variants such as [data-transcript-width=m]_&:...
      // describe sizing, not a transcript container. Keep semantic classes protected.
      if ([...p.classList].some(c => !/[\[\]:]/.test(c) && /message|transcript/i.test(c))) return true;
    }
    return false;
  }
  const controls = 'button,[role="button"],[role="menuitem"],[role="tab"],[role="radio"],[role="switch"],[role="checkbox"],[role="option"],[role="combobox"],label,summary,h1,h2,h3,h4,nav,header';
  const placeholders = new Set(['Write a message…','Write a message...','How can I help you today?','Describe a task or ask a question','Type / for skills','Type / for commands','Search','Search chats','Search projects','Search scheduled tasks']);
  const landingLabels = new Set(['Sessions','Messages','Total tokens','Active days','Current streak','Longest streak','Peak hour','Favorite model','Overview','Models']);
  const scheduledPageCopy = new Set(['Keep awake','No scheduled tasks yet.']);
  const ignored = /^(Claude(?: Code| Max)?|Cowork|Skills?|Models?|Opus(?: [\d.]+)?|Sonnet(?: [\d.]+)?|Haiku(?: [\d.]+)?|GitHub|MCP|API|Beta|Max|Pro|Auto|[\d\W]+)$/i;
  let config = bridge.bootstrap();
  let enabled = false, dictionary = Object.create(null), revision = '';
  const textRecords = new Map(), attrRecords = new Map();
  const scopedRecords = new Set();
  const catalogAttrs = new Set();
  let catalogPane = null;
  let settingsDialogs = new Map();
  let stockSettingsScopes = new Map();
  const memoryRoots = new WeakSet();
  // Native Navigation events cross isolated worlds; wrapping this world's history
  // would NOT observe the page world's pushState/replaceState. Without the native
  // event, fail closed for public catalogue overlays rather than leave stale text.
  const navigation = globalThis.navigation;
  const hasRouteEvents = typeof navigation?.addEventListener === 'function';
  const pending = new Set();
  let applied = 0, flushes = 0, maxScanMs = 0;
  let placeholderStyle = null;
  function syncPlaceholderStyle() {
    if (!enabled || !document.head) return;
    if (!placeholderStyle) placeholderStyle = document.createElement('style');
    const rules = [...placeholders].filter(key => Object.hasOwn(dictionary,key)).map(key =>
      `[contenteditable="true"] p.is-editor-empty[data-placeholder="${CSS.escape(key)}"]::before { content: "${CSS.escape(dictionary[key])}" !important; }`
    ).join('\n');
    if (placeholderStyle.textContent !== rules) placeholderStyle.textContent = rules;
    if (!placeholderStyle.isConnected) document.head.appendChild(placeholderStyle);
  }
  function forgetText(node) {
    textRecords.delete(node);
    scopedRecords.delete(node);
  }
  function collectMutations(records, roots) {
    for (const record of records) {
      if (record.type === 'childList') {
        for (const node of record.addedNodes) roots.add(node);
        // Removing an extra child can restore a suggestion's single-Text shape.
        if (record.removedNodes.length && record.target.nodeType === 1 &&
            homeSuggestions.has(normalize(record.target.textContent))) roots.add(record.target);
      } else {
        // Our writes occur with the observer disconnected. These are framework writes,
        // even when the new value happens to equal our last Chinese output.
        if (record.type === 'characterData') forgetText(record.target);
        if (record.type === 'attributes' && ATTRS.includes(record.attributeName)) attrRecords.get(record.target)?.delete(record.attributeName);
        roots.add(record.target);
      }
    }
  }
  const observer = new MutationObserver(records => {
    if (!enabled) return;
    const roots = new Set();
    collectMutations(records, roots);
    scanRoots(roots); // also handles removed/replaced header radios, outside the pane
    prune();
  });
  const observe = () => observer.observe(document, {subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:[...ATTRS,...CONTEXT_ATTRS]});
  const isDynamicLink = el => {
    const link = el.closest('a[href]');
    return link && /\/(?:chat|project|code|session|task|scheduled-task|epitaxy|artifact)s?\/[^/?#]+/.test(link.getAttribute('href') || '');
  };
  // Only dynamic author/count templates need exact observed structural shapes.
  // Public catalogue prose/controls use exact dictionary keys inside the gate.
  const classes = (el, value) => {
    const tokens = value ? value.split(' ') : [];
    return el && el.classList.length === tokens.length && tokens.every(t => el.classList.contains(t));
  };
  const homeSuggestions = new Set(['Send me a daily briefing','Organize my inbox','Customize Cowork for me']);
  // Public /new suggestions only: these prompts may also be personal task titles.
  // Exact captured leaf/list/wrappers; never authorize generic copy or attributes.
  function homeSuggestionAllowed(el) {
    if (!hasRouteEvents || location.pathname !== '/new' || !el ||
        el.childNodes.length !== 1 || el.firstChild.nodeType !== 3 || el.closest('a')) return false;
    const chain = [
      ['SPAN','min-w-0 flex-1 truncate text-body text-primary'],
      ['BUTTON','group relative flex w-full items-center gap-4 rounded-lg text-left hover:bg-fill-ghost-hover py-2 pl-5 pr-2'],
      ['LI',''], ['UL',''], ['DIV','w-full pt-4'], ['DIV','mx-auto w-full max-w-2xl'],
    ];
    for (const [tag,cls] of chain) {
      if (!el || el.tagName !== tag || !classes(el,cls) || el.hasAttribute('role')) return false;
      el = el.parentElement;
    }
    return true;
  }
  // Observed /epitaxy stats-card leaves only; preserve numeric lexemes and
  // the two approved book names. No Number(), timezone conversion or lookup.
  function codeStatsParts(value) {
    const text = value.trim();
    const hour = text.match(/^(1[0-2]|[1-9]) (AM|PM)$/);
    if (hour) return {kind:'hour',hour:hour[1],period:hour[2]};
    const comparison = text.match(/^You’ve used (~[0-9]{1,18}×) more tokens than (The Hobbit|Dune)\.$/u);
    return comparison ? {kind:'comparison',amount:comparison[1],name:comparison[2]} : null;
  }
  // Reject unsupported lookalikes too, so a dictionary cannot bypass the
  // preserving grammar with an unapproved name, number format or suffix.
  const codeStatsPayload = value => /^\d[\d:.,]*\s+[AP]M\b/i.test(value.trim()) ||
    /^You[’']ve used .* more tokens than /u.test(value.trim());
  function codeStatsTemplate(value, el) {
    if (!hasRouteEvents || location.pathname !== '/epitaxy' || !el ||
        !el.closest('[data-testid="epitaxy-stats-card"]') ||
        el.tagName !== 'SPAN' || el.childNodes.length !== 1 ||
        el.firstChild.nodeType !== 3 || isPrivate(el) || isDynamicLink(el) ||
        el.closest('a,button,[hidden],[aria-hidden="true"],[contenteditable],#customize-pane')) return null;
    const card = el.closest('[data-testid="epitaxy-stats-card"]');
    for (let ancestor = el; ancestor; ancestor = ancestor.parentElement) {
      if (!ancestor.hasAttribute('role')) continue;
      // Verified outer desktop pane, never a role inside/on the stats card.
      if (ancestor.tagName !== 'DIV' || ancestor.getAttribute('role') !== 'region' ||
          ancestor === card || !ancestor.contains(card) ||
          !classes(ancestor,'dframe-pane dframe-pane-primary min-w-0 relative flex flex-col')) return null;
    }
    const parent = el.parentElement, parts = codeStatsParts(value);
    if (parent?.tagName !== 'DIV' || !parts) return null;
    if (parts.kind === 'hour' &&
        classes(el,'tabular-nums text-primary truncate text-body-semibold') &&
        classes(parent,'flex flex-col gap-0.5 p-xs rounded-[5px] bg-alpha-2')) {
      return `${parts.period === 'AM' ? '上午' : '下午'} ${parts.hour} 點`;
    }
    if (parts.kind === 'comparison' &&
        classes(el,'text-caption text-muted pt-[4px]') &&
        classes(parent,'flex flex-col gap-xs')) {
      return `你使用的 token 數比 ${parts.name} 多 ${parts.amount}。`;
    }
    return null;
  }
  const catalogueLandings = new Map([
    ['/customize/skills',['New skills','Most installed skills']],
    ['/customize/connectors',['Top connectors']],
    ['/customize/plugins',['New plugins','Most installed plugins']],
  ]);
  function catalogueHeading(el) {
    const parent = el.parentElement;
    if (el.childNodes.length !== 1 || el.firstChild.nodeType !== 3 ||
        el.hasAttribute('role') || parent?.tagName !== 'DIV' || parent.hasAttribute('role')) return false;
    // Only the landing authorization marker uses observed classes. Catalogue
    // cards/descriptions below it remain exact-dictionary, not CSS-chain locked.
    return location.pathname === '/customize/connectors'
      ? el.tagName === 'H2' && classes(el,'text-heading-semibold text-primary') &&
        classes(parent,'flex min-w-0 gap-xs items-center')
      : el.tagName === 'H3' && classes(el,'m-0 truncate text-heading-semibold text-primary') &&
        classes(parent,'flex min-w-0 items-baseline');
  }
  function catalogueKind(el) {
    if (!el || el.childNodes.length !== 1 || el.firstChild.nodeType !== 3) return null;
    const parent = el.parentElement;
    if (el.tagName !== 'SPAN') return null;
    if (el.hasAttribute('role') || parent?.tagName !== 'SPAN' || parent.hasAttribute('role')) return null;
    if (classes(el,'block min-w-0 overflow-x-clip text-ellipsis whitespace-nowrap') &&
        classes(parent,'min-w-0 truncate text-footnote leading-4 text-muted')) return 'author';
    if (classes(parent,'')) {
      if (classes(el,'')) return 'compact-count';
      if (classes(el,'sr-only')) return 'total-count';
    }
    return null;
  }
  function catalogueTemplate(value, kind) {
    // Preserve author spelling/spacing and the original numeric representation.
    const text = value.trim();
    if (kind === 'author') {
      const m = text.match(/^by ([^\r\n]{1,120})$/u);
      return m ? `作者：${m[1]}` : null;
    }
    if (kind === 'compact-count') {
      const m = text.match(/^(\d+(?:\.\d+)?M?) installs$/);
      return m ? `${m[1]} 次安裝` : null;
    }
    if (kind === 'total-count') {
      const m = text.match(/^(\d{1,3}(?:,\d{3})+|\d+) installs across all of Claude$/);
      return m ? `在 Claude 中共安裝 ${m[1]} 次` : null;
    }
    return null;
  }
  const cataloguePayload = key => ['author','compact-count','total-count'].some(kind => catalogueTemplate(key,kind) !== null);
  function publicCataloguePane() {
    const headings = catalogueLandings.get(location.pathname);
    if (!hasRouteEvents || !headings) return null;
    const panes = document.querySelectorAll('#customize-pane');
    if (panes.length !== 1 || isPrivate(panes[0]) || isDynamicLink(panes[0])) return null;
    const pane = panes[0];
    // The observed header lives OUTSIDE #customize-pane. Require one unambiguous
    // Yours/Discover pair; private/chat/draft radios cannot grant public scope.
    const radios = [...document.querySelectorAll('span[role="radio"]')].filter(el =>
      !pane.contains(el) && !isPrivate(el) && !isDynamicLink(el) &&
      !el.closest('[hidden],[aria-hidden="true"]'));
    const labelIs = (el, key) => normalize(el.textContent) === key ||
      (Object.hasOwn(dictionary,key) && normalize(el.textContent) === dictionary[key]);
    // Radio state can change before the old Yours list is replaced. Only the
    // observed public landing headings (not Data/card titles) grant this scope.
    const landing = [...pane.querySelectorAll('h2,h3')].some(el =>
      catalogueHeading(el) && !isPrivate(el) && !isDynamicLink(el) &&
      !el.closest('a,[role="button"],[hidden],[aria-hidden="true"]') &&
      headings.some(key => labelIs(el,key)));
    if (!landing) return null;
    const discover = radios.filter(el => labelIs(el,'Discover'));
    const yours = radios.filter(el => labelIs(el,'Yours'));
    return discover.length === 1 && yours.length === 1 &&
      discover[0].getAttribute('aria-checked') === 'true' &&
      yours[0].getAttribute('aria-checked') === 'false' ? pane : null;
  }
  const inCatalogue = el => !!el && !!catalogPane && catalogPane.contains(el);
  const desktopLabels = new Set(['Desktop app version','Run on startup','Quick access shortcut','Voice shortcut','Menu bar','Keep computer awake']);
  const generalLabels = new Set(['Theme','Chat font','Motion','Language','Style','Speed','Response completions','Scheduled tasks','Code notifications','Emails from Claude Code cloud sessions','Dispatch messages']);
  function modalSettingLabel(el, key) {
    // Public settings-shapes/structure evidence: remote modal, not /settings.
    // Do not authorize arbitrary dialog text, values, inputs or other links.
    const dialog = el.closest('[role="dialog"]');
    if (!dialog) return false;
    if (key === 'Connected browsers') {
      const column = el.parentElement, group = column?.parentElement;
      const section = group?.parentElement, main = section?.parentElement;
      return el.tagName === 'DIV' && classes(el,'text-sm text-secondary') &&
        el.childNodes.length === 1 && el.firstChild.nodeType === 3 &&
        column?.tagName === 'DIV' && classes(column,'flex flex-col gap-2') &&
        group?.matches('div.settings-group-dividers') && section?.tagName === 'SECTION' &&
        !section.id && classes(section,'mb-xl last:mb-0') &&
        main?.tagName === 'MAIN' && classes(main,'flex flex-col') &&
        main.parentElement?.matches('div.overflow-y-auto') && stockSafe(el) &&
        [...main.children].some(marker => marker.matches('section#general-desktop') &&
          marker.closest('[role="dialog"]') === dialog && stockSafe(marker));
    }
    if (generalLabels.has(key) && el.matches('span.settings-row-title')) {
      return [...dialog.querySelectorAll('nav li[data-testid="general-settings"]')].some(marker =>
        marker.closest('[role="dialog"]') === dialog && !isPrivate(marker) && !isDynamicLink(marker));
    }
    if (desktopLabels.has(key) && el.matches('span.settings-row-title')) {
      const section = el.closest('section');
      return section?.id === 'general-desktop' && section.closest('[role="dialog"]') === dialog;
    }
    return key === 'Learn more' && el.matches('a.cds-text-link') &&
      [...dialog.querySelectorAll('section#general-desktop')].some(section =>
        section.closest('[role="dialog"]') === dialog && !isPrivate(section) && !isDynamicLink(section));
  }
  // Finite official row pairs, not dictionary-wide permission for a dialog.
  // Sources: settings-resume-*-fragments-valid + settings-memory-stock-valid.
  const stockRows = {
    privacy: new Map([
      ['Location metadata','Allow Claude to use coarse location metadata (city/region) to improve product experiences.'],
      ['Help improve our AI models','Allow the use of your chats and coding sessions to train and improve Anthropic AI models.'],
      ['Export data',null],['Shared chats',null],['Shared artifacts',null],['Uploaded files',null],
    ]),
    capabilities: new Map([
      ['Tool access mode','Controls how connector tools are loaded in new conversations.'],
      ['Connector search','Let Claude search the connector directory and surface ones relevant to your conversation.'],
      ['Switch models when a message is flagged','When safeguards flag a message, automatically switch to a different model to keep chatting. When off, your chat will pause instead.'],
      ['Artifacts',null],
      ['AI-powered artifacts','Build apps and interactive documents that use Claude inside the artifact.'],
      ['Inline visualizations','Allow Claude to generate interactive visualizations, charts, and diagrams directly in the conversation.'],
    ]),
    memory: new Map([
      ['Search and reference chats','Allow Claude to search for relevant details in past chats.'],
      ['Generate memory from chats','Allow Claude to generate memory from your chats.'],
      ['Include sensitive topics in memory','Allow Claude to save details about sensitive topics like health conditions or religious beliefs to memory.'],
      ['Import memory from other AI providers',"Bring relevant context and data from another AI provider to Claude. We'll provide a prompt you can use to fetch the memory from your other account."],
    ]),
  };
  const privacyIntro = [
    'Anthropic believes in transparent data practices','.',
    'Learn how your information is protected when using Anthropic products, and visit our',
    'Privacy Center','and','Privacy Policy','for more details.',
  ];
  const stockExtra = ['How we protect your data','How we use your data','Your data','Visuals','Load tools when needed','Start import','Learn more','Connected browsers'];
  const stockKeys = new Set([...Object.values(stockRows).flatMap(rows => [...rows].flat().filter(Boolean)),...privacyIntro,...stockExtra]);
  const sharedStockKeys = new Set(['Artifacts','Learn more','Export data','Your data','Visuals']);
  const stockColumnClass = 'flex min-w-0 flex-1 flex-col justify-center gap-1';
  const stockRowClass = 'flex items-center justify-between gap-lg py-md';
  const memoryRootClass = '-ml-[calc(var(--cds-pad-lg)+var(--cds-pad-md)-var(--cds-pad-xl))] flex min-h-0 flex-1 flex-col';
  const memoryHeadingClass = 'mb-md flex shrink-0 items-center gap-2 pl-md pt-1 text-heading-semibold text-primary';
  const textIs = (text,key) => normalize(text) === key ||
    (Object.hasOwn(dictionary,key) && normalize(text) === dictionary[key]);
  const oneTextIs = (el,key) => el?.childNodes.length === 1 && el.firstChild.nodeType === 3 && textIs(el.firstChild.nodeValue,key);
  const stockSafe = el => !!el && !isPrivate(el) && !isDynamicLink(el) && !el.closest('[hidden],[aria-hidden="true"]');
  function stockIntroElement(root) {
    const candidates = [...root.querySelectorAll('p.text-body.text-secondary')].filter(p =>
      p.parentElement?.tagName === 'DIV' && classes(p.parentElement,'flex flex-col gap-sm') &&
      p.parentElement.parentElement?.tagName === 'DIV' && classes(p.parentElement.parentElement,'flex flex-col gap-md pb-xl') &&
      p.parentElement.parentElement.parentElement === root && stockSafe(p));
    return candidates.find(p => p.childNodes.length === 7 && [...p.childNodes].every((node,i) => {
      if (i !== 3 && i !== 5) return node.nodeType === 3 &&
        (textIs(node.nodeValue,privacyIntro[i]) || (i === 4 && normalize(node.nodeValue) === '與'));
      if (node.nodeType !== 1 || !node.matches('a.cds-text-link') || !oneTextIs(node,privacyIntro[i]) || !stockSafe(node)) return false;
      try { return node.hasAttribute('href') && new URL(node.getAttribute('href'),location.href).pathname === (i === 3 ? '/' : '/legal/privacy'); }
      catch { return false; }
    })) || null;
  }
  function stockRowInfo(row,page,root) {
    if (!row || row.tagName !== 'DIV' || row.getAttribute('role') !== 'group' || !classes(row,stockRowClass) || !stockSafe(row)) return null;
    let group = row.parentElement;
    // The model-improvement row has one observed relative role=group wrapper.
    if (page === 'privacy' && group?.getAttribute('role') === 'group' && classes(group,'relative')) group = group.parentElement;
    const section = group?.parentElement;
    if (!group?.matches('div.settings-group-dividers') || section?.tagName !== 'SECTION' || section.parentElement !== root ||
        !classes(section,page === 'memory' ? 'mb-xl last:mb-0 !mb-0 px-md' : 'mb-xl last:mb-0')) return null;
    const columns = [...row.children].filter(el => el.tagName === 'DIV' && classes(el,stockColumnClass));
    if (columns.length !== 1) return null;
    const column = columns[0];
    const titles = [...column.children].filter(el => el.tagName === 'DIV' && classes(el,'text-body text-primary'))
      .flatMap(el => [...el.children].filter(child => child.matches('span.settings-row-title') && stockSafe(child)));
    if (titles.length !== 1) return null;
    const key = [...stockRows[page].keys()].find(key => oneTextIs(titles[0],key));
    if (!key) return null;
    const descriptions = [...column.children].filter(el => el.tagName === 'DIV' && classes(el,'text-body text-muted'));
    if (descriptions.length > 1) return null;
    return {row,column,title:titles[0],key,description:descriptions[0] || null,prose:stockRows[page].get(key)};
  }
  function stockDescriptionHost(info,page) {
    const description = info.description;
    if (!description || !stockSafe(description)) return null;
    if (page === 'privacy' && info.key === 'Help improve our AI models') {
      const outer = description.children[0], inner = outer?.children[0];
      return outer?.tagName === 'SPAN' && classes(outer,'flex flex-col gap-xs') &&
        inner?.tagName === 'SPAN' && classes(inner,'') && stockSafe(inner) ? inner : null;
    }
    return description;
  }
  function stockHasProse(info,page) {
    const host = stockDescriptionHost(info,page);
    return !!info.prose && !!host && [...host.childNodes].some(n => n.nodeType === 3 && textIs(n.nodeValue,info.prose));
  }
  function selectedStockPage(dialog) {
    const navs = [...dialog.querySelectorAll('nav')].filter(nav =>
      nav.closest('[role="dialog"]') === dialog && stockSafe(nav) &&
      [...nav.querySelectorAll('li[data-testid="general-settings"]')].some(marker =>
        marker.closest('[role="dialog"]') === dialog && marker.closest('nav') === nav && stockSafe(marker)));
    if (navs.length !== 1) return null;
    const selected = [...navs[0].querySelectorAll('button[aria-current="page"]')].filter(el =>
      el.closest('[role="dialog"]') === dialog && stockSafe(el));
    if (selected.length !== 1) return null;
    const li = selected[0].parentElement;
    if (li?.tagName !== 'LI') return null;
    if (li.getAttribute('data-testid') === 'data-privacy-controls') return 'privacy';
    if (li.getAttribute('data-testid') === 'memory-settings') return 'memory';
    // Captured nav leaves: separate hidden icon + visible one-Text label.
    // Never strip a private-use glyph from aggregate text to guess a page.
    const button = selected[0], [icon,label] = button.children;
    if (!li.hasAttribute('data-testid') && !button.hasAttribute('role') && button.childNodes.length === 2 &&
        icon?.tagName === 'SPAN' && !icon.hasAttribute('role') && classes(icon,'shrink-0 text-secondary') &&
        icon.getAttribute('aria-hidden') === 'true' && icon.childNodes.length === 1 && icon.firstChild.nodeType === 3 &&
        label?.tagName === 'SPAN' && !label.hasAttribute('role') && classes(label,'min-w-0 flex-1 truncate') &&
        stockSafe(label) && oneTextIs(label,'Capabilities')) return 'capabilities';
    return null;
  }
  function readStockSettingsScopes(rootsToScan) {
    const scopes = new Map();
    for (const dialog of document.querySelectorAll('[role="dialog"]')) {
      if (!stockSafe(dialog)) continue;
      const page = selectedStockPage(dialog);
      if (!page) continue;
      const scrollRoots = [...dialog.querySelectorAll('div.overflow-y-auto')].filter(el =>
        el.closest('[role="dialog"]') === dialog && !el.closest('nav,aside'))
        .flatMap(el => [...el.children]);
      if (page === 'memory') for (const root of scrollRoots) {
        if (!memoryRoots.has(root)) {
          memoryRoots.add(root);
          // Also restore generic overlays applied before the Memory selection
          // arrived. Protection does not require an already-known root class.
          rootsToScan.add(root);
        }
      }
      const roots = scrollRoots.filter(root => stockSafe(root) &&
          (page === 'privacy' ? root.tagName === 'DIV' && classes(root,'flex flex-col') :
           page === 'capabilities' ? root.tagName === 'MAIN' && classes(root,'flex flex-col pb-10') :
           root.tagName === 'DIV' && classes(root,memoryRootClass)));
      const valid = roots.filter(root => {
        if (page === 'privacy') return !!stockIntroElement(root);
        const sentinel = page === 'capabilities' ? 'Tool access mode' : 'Search and reference chats';
        return [...root.querySelectorAll('div[role="group"]')].some(row => {
          const info = stockRowInfo(row,page,root);
          return info?.key === sentinel && stockHasProse(info,page);
        });
      });
      if (valid.length === 1) scopes.set(dialog,{page,root:valid[0]});
    }
    return scopes;
  }
  function stockSettingAllowed(el,key) {
    if (!el) return false;
    const dialog = el.closest('[role="dialog"]'), scope = stockSettingsScopes.get(dialog);
    if (!scope || !scope.root.contains(el) || !stockSafe(el) || el.closest('nav,aside,[role="list"],[role="listitem"]')) return false;
    const {page,root} = scope;
    if (page === 'memory' && key === 'Memory') {
      // Observed single-Text stock H2, directly under the proven Memory root.
      // Ambiguous duplicates cannot authorize a private sibling with the same name.
      const headings = [...root.children].filter(h => h.tagName === 'H2' &&
        classes(h,memoryHeadingClass) && stockSafe(h) && oneTextIs(h,'Memory'));
      return headings.length === 1 && headings[0] === el;
    }
    if (page === 'privacy') {
      const intro = stockIntroElement(root);
      if (el === intro) return privacyIntro.includes(key);
      if (el.parentElement === intro && el.matches('a.cds-text-link')) return ['Privacy Center','Privacy Policy'].includes(key);
      // These accordion/header shapes are observed stock UI, not arbitrary headings.
      if (['How we protect your data','How we use your data'].includes(key) &&
          el.tagName === 'SPAN' && classes(el,'text-body text-primary') &&
          el.parentElement?.tagName === 'BUTTON' && el.parentElement.parentElement?.tagName === 'DIV' &&
          classes(el.parentElement.parentElement,'flex flex-col') &&
          el.parentElement.parentElement.parentElement?.matches('div.divide-y.divide-alpha-1')) return true;
    }
    if (key === (page === 'privacy' ? 'Your data' : page === 'capabilities' ? 'Visuals' : null) &&
        el.matches('h3.settings-row-title') && classes(el.parentElement,'flex min-w-0 flex-col gap-1') &&
        classes(el.parentElement.parentElement,'mb-md flex items-start justify-between gap-lg') &&
        el.parentElement.parentElement.parentElement?.tagName === 'SECTION' &&
        el.parentElement.parentElement.parentElement.parentElement === root) return true;
    const info = stockRowInfo(el.closest('div[role="group"]'),page,root);
    if (!info) return false;
    if (info.prose && !stockHasProse(info,page)) return false;
    if (el === info.title && key === info.key) return true;
    const host = stockDescriptionHost(info,page);
    if (host && el === host && key === info.prose) return true;
    if (host && el.tagName === 'A' && el.parentElement === host && el.matches('a.cds-text-link') && key === 'Learn more') return stockHasProse(info,page);
    if (page === 'capabilities' && info.key === 'Tool access mode' && key === 'Load tools when needed' &&
        el.tagName === 'SPAN' && classes(el,'min-w-0 flex-1 truncate') && el.parentElement?.matches('button[role="combobox"]') &&
        el.parentElement.parentElement?.parentElement?.parentElement === info.row) return stockHasProse(info,page);
    return ((page === 'privacy' && info.key === 'Export data' && key === 'Export data') ||
            (page === 'memory' && info.key === 'Import memory from other AI providers' && key === 'Start import')) &&
      el.tagName === 'SPAN' && classes(el,'inline-flex min-w-0 items-center gap-1') && el.parentElement?.tagName === 'BUTTON' &&
      classes(el.parentElement.parentElement,'flex shrink-0 items-center') && el.parentElement.parentElement.parentElement === info.row;
  }
  function eligible(el, key, attr = null) {
    if (!el || !key) return false;
    // Placeholders are the only exception for editable controls; never edit their value/text.
    if (attr === 'placeholder' && placeholders.has(key) && !el.closest('#customize-pane')) return true;
    if (isPrivate(el) || isDynamicLink(el)) return false;
    // This is a restriction, never a bypass of later Memory/Yours scope guards.
    if (homeSuggestions.has(key) && (attr || !homeSuggestionAllowed(el))) return false;
    // The verified Memory content root also contains generated private memories
    // below its stock section. Never let the generic dictionary/control fallback
    // authorize those siblings, even during navigation-selection races.
    for (let ancestor = el; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.tagName === 'DIV' && classes(ancestor,memoryRootClass)) memoryRoots.add(ancestor);
      // Scope loss must not expose already recognized private-memory containers
      // to the generic long-copy fallback. Weak ownership cannot retain DOM.
      if (memoryRoots.has(ancestor)) {
        return !attr && stockSettingAllowed(el,key);
      }
    }
    if (codeStatsPayload(key)) return !attr && codeStatsTemplate(key,el) !== null;
    // Attribute payloads must never use dictionary entries to rename an author
    // or change an installation count. Templates are text-node-only.
    if (cataloguePayload(key) && (attr || !inCatalogue(el))) return false;
    // Entire Yours pane stays protected, including descriptions and attributes.
    // No class-chain restriction on curated public copy; never partial matches.
    if (el.closest('#customize-pane')) {
      if (!inCatalogue(el)) return false;
      if (attr) return ATTRS.includes(attr) && Object.hasOwn(dictionary,key);
      if (!el.matches('p,span,h2,h3,button,a')) return false;
      // Author/numeric payloads may only use the verified preserving templates,
      // even if a mistaken dictionary entry tries to replace them.
      if (cataloguePayload(key)) {
        return catalogueTemplate(key,catalogueKind(el)) !== null;
      }
      return Object.hasOwn(dictionary,key);
    }
    if (stockKeys.has(key) && (el.closest('[role="dialog"]') || !sharedStockKeys.has(key))) {
      // Existing System help remains separately authorized. No new permission
      // for attributes, sibling custom values, nested dialogs or private lists.
      return !attr && (stockSettingAllowed(el,key) ||
        (['Learn more','Connected browsers'].includes(key) && modalSettingLabel(el,key)));
    }
    if (attr) return ATTRS.includes(attr);
    // Preserve the existing full-page settings fallback after privacy/pane
    // guards, before the narrower remote-modal title rules.
    if (location.pathname.startsWith('/settings') && el.matches('p,span,div,li,a')) return true;
    if (el.matches('span.settings-row-title') && (desktopLabels.has(key) || generalLabels.has(key))) {
      return modalSettingLabel(el,key);
    }
    if (modalSettingLabel(el,key)) return true;
    if (el.closest(controls)) return true;
    // Verified stock greeting on the new-conversation page; not chat headings
    // or arbitrary short spans elsewhere.
    if (location.pathname === '/new' && key === 'Here we go!' &&
        el.matches('.font-display span.select-none')) return true;
    // Stock empty-state/switch copy on the task index only, not task detail,
    // custom task rows, lists, links, or arbitrary short text elsewhere.
    if (location.pathname === '/scheduled-task' && scheduledPageCopy.has(key) &&
        !el.closest('a,aside,[role="list"],[role="listitem"]')) return true;
    if (el.closest('[data-testid="epitaxy-stats-card"]') && (landingLabels.has(key) || ['All','30d','7d'].includes(key))) return true;
    if (el.closest('[data-testid="draft-rail-place"],[data-testid="epitaxy-env-pill"]') && ['Local','Remote','Cloud'].includes(key)) return true;
    if (el.closest('[data-testid="rail-preset-trigger"],[data-testid="preset-row-permission"],[data-testid="preset-row-effort"]') && ['Manual','Auto','Plan','High','Medium','Low','Extra high'].includes(key)) return true;
    // Only exact curated long labels outside controls, never partial matching of user text.
    return Object.hasOwn(dictionary,key) && key.length >= 24 && !el.closest('aside,[role="list"],[role="listitem"]');
  }
  function translation(value, el) {
    const key = normalize(value);
    // Only the verified seven-node Privacy introduction; never a global key.
    if (key === 'and' && stockSettingAllowed(el,key)) return '與';
    if (codeStatsPayload(key)) return codeStatsTemplate(value,el);
    if (inCatalogue(el)) {
      const template = catalogueTemplate(value,catalogueKind(el));
      if (template !== null) return template;
    }
    if (Object.hasOwn(dictionary,key)) return dictionary[key];
    // Only official Code landing headings. Names remain dynamic and never enter the index.
    if (/^\/epitaxy(?:\/|$)/.test(location.pathname) && el?.closest('header h1')) {
      const next = key.match(/^What[’']s up next, (.{1,80})\?$/);
      if (next) return `接下來要做什麼，${next[1]}？`;
      const welcome = key.match(/^Welcome back, (.{1,80})$/);
      if (welcome) return `歡迎回來，${welcome[1]}`;
    }
    return null;
  }
  function recordUnknown(el,key,attr) {
    if (pending.size >= 500 || key.length > 120 || !/[A-Za-z]/.test(key) || /[\u3400-\u9fff/@\\{}\[\]`=]/.test(key) || ignored.test(key)) return;
    // Unknown labels remain in memory only. Reports contain counts, never these strings.
    if (attr || el.closest('button,[role="menuitem"],[role="tab"],label,h1,h2,h3')) pending.add(`${el.tagName}|${attr||'text'}|${key}`);
  }
  function applyText(node) {
    const current = node.nodeValue || '', old = textRecords.get(node);
    if (old && current === old.output) {
      if ((old.stockSetting && !stockSettingAllowed(node.parentElement,normalize(old.source))) ||
          (old.catalogue && !inCatalogue(node.parentElement)) ||
          !eligible(node.parentElement,normalize(old.source))) { node.nodeValue=old.source; forgetText(node); }
      return;
    }
    if (old) forgetText(node); // React recycled a node: stale source must never win.
    const el = node.parentElement, key = normalize(current);
    if (!eligible(el,key)) return;
    const target = translation(current, el);
    if (!target) { recordUnknown(el,key,null); return; }
    if (target === key) return;
    const output = replaceLabel(current, target);
    const catalogue = inCatalogue(el);
    const stockSetting = stockSettingAllowed(el,key);
    textRecords.set(node,{source:current,output,catalogue,stockSetting});
    if (catalogue || stockSetting || modalSettingLabel(el,key) || codeStatsPayload(key) || homeSuggestions.has(key)) scopedRecords.add(node);
    node.nodeValue = output; applied++;
  }
  function applyAttrs(el) {
    for (const attr of ATTRS) {
      if (!el.hasAttribute(attr)) continue;
      const current = el.getAttribute(attr), old = attrRecords.get(el)?.get(attr);
      if (old && current === old.output) {
        if ((old.catalogue && !inCatalogue(el)) || !eligible(el,normalize(old.source),attr)) {
          el.setAttribute(attr,old.source);attrRecords.get(el).delete(attr);
        }
        continue;
      }
      if (old) attrRecords.get(el).delete(attr);
      const key = normalize(current);
      if (!eligible(el,key,attr)) continue;
      const target = translation(current, el);
      if (!target) { recordUnknown(el,key,attr); continue; }
      if (target === key) continue;
      const output = replaceLabel(current, target);
      if (!attrRecords.has(el)) attrRecords.set(el,new Map());
      const catalogue = inCatalogue(el);
      attrRecords.get(el).set(attr,{source:current,output,catalogue});
      if (catalogue) catalogAttrs.add(el);
      el.setAttribute(attr,output); applied++;
    }
  }
  function prune() {
    for (const [node,record] of textRecords) if (!node.isConnected) {
      // A detached public row can later be reused in Yours/private content.
      // Drop ownership only after removing our own scoped overlay.
      if (scopedRecords.has(node) && node.nodeValue === record.output) node.nodeValue = record.source;
      forgetText(node);
    }
    for (const [el,attrs] of attrRecords) {
      if (!el.isConnected) {
        for (const [attr,record] of attrs) if (record.catalogue && el.getAttribute(attr) === record.output) el.setAttribute(attr,record.source);
        attrRecords.delete(el); catalogAttrs.delete(el);
      } else if (![...attrs.values()].some(record => record.catalogue)) catalogAttrs.delete(el);
    }
  }
  function scan(root) {
    if (!enabled || !root) return;
    scanRoots(new Set([root]));
  }
  function scanRoots(roots) {
    if (!enabled) return;
    const start = performance.now();
    // A route event can fire before the MutationObserver microtask. Respect any
    // pending framework writes (even writes equal to our last Chinese output).
    collectMutations(observer.takeRecords(), roots);
    observer.disconnect();
    try {
      // Style stays OUTSIDE the ProseMirror editable subtree: no mutation/IME loop.
      syncPlaceholderStyle();
      const stockScopes = readStockSettingsScopes(roots);
      for (const [dialog,scope] of stockSettingsScopes) if (scope.root.isConnected &&
          (stockScopes.get(dialog)?.root !== scope.root || stockScopes.get(dialog)?.page !== scope.page)) roots.add(scope.root);
      for (const [dialog,scope] of stockScopes) if (stockSettingsScopes.get(dialog)?.root !== scope.root ||
          stockSettingsScopes.get(dialog)?.page !== scope.page) roots.add(scope.root);
      stockSettingsScopes = stockScopes;
      // A row title and its description authorize each other. When just one
      // changes, recheck the finite stock rows, not generated Memory siblings.
      for (const {page,root} of stockScopes.values()) {
        // Recheck ambiguity when a matching sibling heading is added/removed.
        if (page === 'memory') for (const child of root.children) {
          if (child.tagName === 'H2' && classes(child,memoryHeadingClass)) roots.add(child);
        }
        for (const row of root.querySelectorAll('div[role="group"]')) {
          if (stockRowInfo(row,page,root)) roots.add(row);
        }
      }
      // Help links are in a sibling section: marker removal/reinsertion must
      // invalidate/re-enable that sibling too, not just the mutated subtree.
      const dialogs = new Map();
      for (const marker of document.querySelectorAll('section#general-desktop,nav li[data-testid="general-settings"]')) {
        const dialog = marker.closest('[role="dialog"]');
        if (dialog && !isPrivate(marker) && !isDynamicLink(marker)) {
          dialogs.set(dialog,(dialogs.get(dialog) || 0) | (marker.tagName === 'SECTION' ? 1 : 2));
        }
      }
      for (const [dialog,scope] of settingsDialogs) if (dialogs.get(dialog) !== scope && dialog.isConnected) roots.add(dialog);
      for (const [dialog,scope] of dialogs) if (settingsDialogs.get(dialog) !== scope) roots.add(dialog);
      settingsDialogs = dialogs;
      const previous = catalogPane;
      catalogPane = publicCataloguePane();
      if (previous !== catalogPane) {
        if (previous?.isConnected) roots.add(previous);
        if (catalogPane) roots.add(catalogPane);
      }
      const visited = new Set();
      const visit = node => {
        if (visited.has(node)) return;
        visited.add(node);
        if (node.nodeType === 3) applyText(node);
        else if (node.nodeType === 1) applyAttrs(node);
      };
      // Ownership stays node-specific. On scope loss, restore only still-owned
      // outputs, including reused or moved nodes; never overwrite framework text.
      for (const node of scopedRecords) if (node.isConnected) visit(node);
      for (const el of catalogAttrs) if (el.isConnected) visit(el);
      for (const root of roots) {
        visit(root);
        if (root.nodeType !== 3) {
          const walker = document.createTreeWalker(root,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) visit(walker.currentNode);
        }
      }
    } finally { observe(); }
    flushes++;
    maxScanMs = Math.max(maxScanMs, performance.now()-start);
  }
  function restore() {
    // A same-task framework write can equal our last output. Consume its pending
    // mutation first so disabling/revision changes cannot resurrect stale English.
    collectMutations(observer.takeRecords(),new Set());
    observer.disconnect();
    placeholderStyle?.remove();
    for (const [node,r] of textRecords) if (node.nodeValue === r.output) node.nodeValue = r.source;
    for (const [el,attrs] of attrRecords) for (const [attr,r] of attrs) if (el.getAttribute(attr) === r.output) el.setAttribute(attr,r.source);
    textRecords.clear(); attrRecords.clear(); scopedRecords.clear(); catalogAttrs.clear(); catalogPane = null; settingsDialogs.clear(); stockSettingsScopes.clear();
    observe();
  }
  function update(next) {
    if (!next || next.schema !== 2) next = {enabled:false,dictionary:{},revision:''};
    const active = next.enabled === true && next.compatible === true;
    if (enabled && (!active || next.revision !== revision)) restore();
    const changed = enabled !== active || revision !== next.revision;
    enabled = active; revision = next.revision || '';
    dictionary = next.dictionary || Object.create(null);
    config = next;
    if (changed && enabled) { pending.clear(); scan(document); }
  }
  observe();
  update(config);
  const routeChanged = () => {
    if (enabled) {
      // Returning to Code can reuse original English nodes without DOM writes.
      const roots = location.pathname === '/epitaxy'
        ? document.querySelectorAll('[data-testid="epitaxy-stats-card"]')
        : location.pathname === '/new' ? document.querySelectorAll('li > button > span') : [];
      scanRoots(new Set(roots)); prune();
    }
  };
  if (hasRouteEvents) navigation.addEventListener('currententrychange',routeChanged);
  // Poll small local IPC for toggle/dictionary changes; never blocks first translation.
  let polling = false;
  const timer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      update(await bridge.refresh()); prune();
      bridge.report({unknownCount:pending.size,mismatchCount:config.compatible===false?1:0,appliedCount:applied,flushCount:flushes,maxScanMs:Math.round(maxScanMs*100)/100,revision});
    } catch {} finally { polling = false; }
  },1000);
  return {scan,update,restore,stats:()=>({applied,flushes,maxScanMs,unknownCount:pending.size}),dispose:()=>{clearInterval(timer);observer.disconnect();if(hasRouteEvents)navigation.removeEventListener('currententrychange',routeChanged);}};
}
if (typeof module !== 'undefined') module.exports = installClaudeTW;
