// ==UserScript==
// @name         网页元素选择器（Agent Element Inspector）
// @namespace    https://github.com/local/agent-element-inspector
// @version      0.0.1
// @description  面向浏览器 Agent 的网页元素侦察工具：人工精准选中元素 → 采集完整 DOM 事实 → 生成并验证多框架定位表达式 → 输出 Agent 可直接使用的信息包
// @author       左³
// @license      All Rights Reserved
// @homepageURL  https://www.strava.com/athletes/142433407
// @supportURL   https://www.strava.com/athletes/142433407
// @match        *://*/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  if (window.__AEI_ACTIVE__) return;
  window.__AEI_ACTIVE__ = true;

  var VERSION = '0.0.1';
  var Z_BASE = 2147483000;
  var MAX_PREVIEW = 12000;
  var MAX_TEXT_IN_JSON = 20000;
  var MAX_HTML_IN_JSON = 200000;

  /* =========================================================
   * 一、基础工具
   * ========================================================= */

  function cssEsc(s) {
    s = String(s);
    if (window.CSS && typeof CSS.escape === 'function') return CSS.escape(s);
    return s.replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, function (m) { return '\\' + m; });
  }

  function attrVal(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ');
  }

  function xpathStr(s) {
    s = String(s);
    if (s.indexOf('"') === -1) return '"' + s + '"';
    if (s.indexOf("'") === -1) return "'" + s + "'";
    var parts = s.split('"');
    return 'concat("' + parts.join('", \'"\', "') + '")';
  }

  function jsStr(s) {
    return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n') + "'";
  }

  function normText(s) {
    return String(s == null ? '' : s).replace(/[\s\u00A0]+/g, ' ').trim();
  }

  function truncate(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n) : s;
  }

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function rafThrottle(fn) {
    var ticking = false, pending = null;
    function throttled() {
      if (ticking) { pending = arguments; return; }
      ticking = true;
      fn.apply(null, arguments);
      requestAnimationFrame(function () {
        ticking = false;
        if (pending) {
          var a = pending;
          pending = null;
          throttled.apply(null, a);
        }
      });
    }
    return throttled;
  }

  function debounce(fn, wait) {
    var t = null;
    return function () {
      var args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(null, args); }, wait);
    };
  }

  function nowISO() {
    var d = new Date();
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) +
      (function () {
        var off = -d.getTimezoneOffset(), s = off >= 0 ? '+' : '-';
        off = Math.abs(off);
        return s + pad(Math.floor(off / 60)) + ':' + pad(off % 60);
      })();
  }

  function copyText(text) {
    var done = function (ok) {
      if (ok) toast('已复制到剪贴板');
      else toast('复制失败，请手动选择文本复制', true);
      return ok;
    };
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return done(true); })
        .catch(function () { return done(legacyCopy(text)); });
    }
    return Promise.resolve(done(legacyCopy(text)));
  }

  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      var ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  function cs(el) {
    var win = el.ownerDocument.defaultView || window;
    return win.getComputedStyle(el);
  }

  /* ---------- Shadow DOM / iframe 遍历 ---------- */

  function getScope(el) {
    var root = el.getRootNode();
    return (root && root.nodeType === 11 && typeof root.querySelectorAll === 'function') ? root : el.ownerDocument;
  }

  function scopeFlag(el) {
    var root = el.getRootNode();
    return (root && root.nodeType === 11 && root.host) ? 'shadow' : 'document';
  }

  function shadowChain(el) {
    var chain = [];
    var node = el.getRootNode();
    var guard = 0;
    while (node && node.nodeType === 11 && node.host && guard++ < 20) {
      chain.unshift({
        host: describeShort(node.host),
        mode: node.mode || 'open'
      });
      node = node.host.getRootNode();
    }
    return chain;
  }

  function frameChain(el) {
    var chain = [];
    var win = el.ownerDocument.defaultView;
    var guard = 0;
    while (win && win !== window && guard++ < 10) {
      var fe = null;
      try { fe = win.frameElement; } catch (e) { fe = null; }
      if (!fe) break;
      chain.unshift({
        tag: fe.tagName.toLowerCase(),
        id: fe.id || null,
        name: fe.getAttribute('name') || null,
        src: truncate(fe.getAttribute('src') || '', 200) || null,
        sameOrigin: true
      });
      win = fe.ownerDocument.defaultView;
    }
    return chain;
  }

  function isOwnUi(node) {
    if (!host || !node || node.nodeType !== 1) return false;
    if (node === host) return true;
    if (ui.panel && (node === ui.panel || ui.panel.contains(node))) return true;
    var root = node.getRootNode ? node.getRootNode() : null;
    if (root && root === shadow) return true;
    return !!(host.contains && host.contains(node));
  }

  function collectOpenRoots(root) {
    var roots = [root];
    var walk = function (scope) {
      var all = scope.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        if (isOwnUi(all[i])) continue;
        var sr = all[i].shadowRoot;
        if (sr && !isOwnUi(sr.host)) { roots.push(sr); walk(sr); }
      }
    };
    try { walk(root); } catch (e) { /* 忽略异常节点树 */ }
    return roots;
  }

  function collectDeepElements(root) {
    var out = [];
    var walk = function (scope) {
      var all = scope.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        if (isOwnUi(all[i])) continue;
        out.push(all[i]);
        if (all[i].shadowRoot) walk(all[i].shadowRoot);
      }
    };
    walk(root);
    return out;
  }

  function byIdDeep(el, id) {
    var scope = getScope(el);
    var found = scope.getElementById ? scope.getElementById(id) : null;
    if (found) return found;
    var roots = collectOpenRoots(scope);
    for (var i = 0; i < roots.length; i++) {
      var f = roots[i].getElementById ? roots[i].getElementById(id) : null;
      if (f) return f;
    }
    return null;
  }

  /* ---------- 元素描述 ---------- */

  function describeShort(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el === document.documentElement) return 'html';
    if (el === document.body) return 'body';
    var s = el.tagName.toLowerCase();
    if (el.id) s += '#' + (el.id.length > 40 ? truncate(el.id, 40) : el.id);
    var cls = Array.from(el.classList || []).slice(0, 3);
    if (cls.length) s += '.' + cls.join('.');
    return s;
  }

  /* ---------- 可见性 / 几何 ---------- */

  function isVisible(el) {
    if (!el || el.nodeType !== 1 || !el.isConnected) return false;
    var p = el;
    var guard = 0;
    while (p && p.nodeType === 1 && guard++ < 400) {
      var s = cs(p);
      if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return false;
      p = p.parentElement || (p.parentNode && p.parentNode.host) || null;
    }
    if (parseFloat(cs(el).opacity) === 0) return false;
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    return true;
  }

  function isRendered(el) {
    return !!(el && el.getClientRects && el.getClientRects().length);
  }

  function inViewport(el) {
    var r = el.getBoundingClientRect();
    var win = el.ownerDocument.defaultView || window;
    return r.bottom > 0 && r.right > 0 && r.top < win.innerHeight && r.left < win.innerWidth;
  }

  function visibleRatio(el) {
    var r = el.getBoundingClientRect();
    var win = el.ownerDocument.defaultView || window;
    var w = Math.max(0, Math.min(r.right, win.innerWidth) - Math.max(r.left, 0));
    var h = Math.max(0, Math.min(r.bottom, win.innerHeight) - Math.max(r.top, 0));
    var area = r.width * r.height;
    return area > 0 ? +(Math.min(1, (w * h) / area).toFixed(3)) : 0;
  }

  function absRect(el) {
    var r = el.getBoundingClientRect();
    var left = r.left, top = r.top;
    var win = el.ownerDocument.defaultView;
    var guard = 0;
    while (win && win !== window && guard++ < 10) {
      var fe = null;
      try { fe = win.frameElement; } catch (e) { fe = null; }
      if (!fe) break;
      var fr = fe.getBoundingClientRect();
      left += fr.left + fe.clientLeft;
      top += fr.top + fe.clientTop;
      win = fe.ownerDocument.defaultView;
    }
    return { x: left, y: top, width: r.width, height: r.height, right: left + r.width, bottom: top + r.height };
  }

  /* ---------- 语义 / ARIA ---------- */

  function getLabelText(el) {
    try {
      if (el.labels && el.labels.length) {
        return normText(Array.from(el.labels).map(function (l) { return l.innerText || l.textContent || ''; }).join(' '));
      }
    } catch (e) { /* 非 labelable 元素 */ }
    var wrap = el.closest ? el.closest('label') : null;
    if (wrap && wrap !== el) return normText(wrap.innerText || wrap.textContent || '');
    return '';
  }

  function getAccessibleName(el) {
    if (!el || el.nodeType !== 1) return '';
    var lb = el.getAttribute('aria-labelledby');
    if (lb) {
      var t = lb.split(/\s+/).map(function (id) {
        var n = byIdDeep(el, id);
        return n ? normText(n.innerText || n.textContent || '') : '';
      }).filter(Boolean).join(' ');
      if (t) return normText(t);
    }
    var al = el.getAttribute('aria-label');
    if (al && normText(al)) return normText(al);

    var tag = el.tagName.toLowerCase();
    var type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'input') {
      if (type === 'button' || type === 'submit' || type === 'reset') {
        var v = normText(el.value || '');
        if (v) return v;
        return type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '';
      }
      if (type === 'image') return normText(el.alt || el.value || '');
    }
    if (tag === 'img' || tag === 'area') {
      var alt = el.getAttribute('alt');
      if (alt != null) return normText(alt);
    }
    var lt = getLabelText(el);
    if (lt) return lt;

    var role = el.getAttribute('role');
    var textual = ['button', 'a', 'summary', 'option', 'label', 'th', 'td', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'legend', 'figcaption', 'li'];
    if (role || textual.indexOf(tag) !== -1) {
      var txt = normText(el.innerText || el.textContent || '');
      if (txt) return txt;
    }
    var title = el.getAttribute('title');
    if (title) return normText(title);
    return '';
  }

  function getImplicitRole(el) {
    var tag = el.tagName.toLowerCase();
    var type = (el.getAttribute('type') || '').toLowerCase();
    switch (tag) {
      case 'a': return el.hasAttribute('href') ? 'link' : '';
      case 'button': return 'button';
      case 'input':
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        if (type === 'number') return 'spinbutton';
        if (type === 'search') return 'searchbox';
        if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button';
        if (type === 'hidden') return '';
        return 'textbox';
      case 'select': return el.multiple ? 'listbox' : 'combobox';
      case 'textarea': return 'textbox';
      case 'img': return el.getAttribute('alt') === '' ? 'presentation' : 'img';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
      case 'ul': case 'ol': case 'menu': return 'list';
      case 'li': return 'listitem';
      case 'table': return 'table';
      case 'tr': return 'row';
      case 'td': return 'cell';
      case 'th': return 'columnheader';
      case 'nav': return 'navigation';
      case 'main': return 'main';
      case 'header': return 'banner';
      case 'footer': return 'contentinfo';
      case 'aside': return 'complementary';
      case 'form': return 'form';
      case 'dialog': return 'dialog';
      case 'iframe': return 'iframe';
      case 'progress': return 'progressbar';
      case 'meter': return 'meter';
      case 'details': return 'group';
      case 'summary': return 'button';
      case 'fieldset': return 'group';
      case 'hr': return 'separator';
      default: return '';
    }
  }

  function getRole(el) {
    return (el.getAttribute('role') || '').trim() || getImplicitRole(el);
  }

  /* ---------- 交互状态 ---------- */

  var INTERACTIVE_ROLES = ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'textbox', 'searchbox', 'combobox', 'slider', 'spinbutton', 'treeitem'];

  function isInteractive(el) {
    var tag = el.tagName.toLowerCase();
    if (['a', 'button', 'input', 'select', 'textarea', 'summary', 'option', 'label'].indexOf(tag) !== -1) {
      if (tag === 'a' && !el.hasAttribute('href')) return false;
      return !el.disabled;
    }
    var role = getRole(el);
    if (INTERACTIVE_ROLES.indexOf(role) !== -1) return true;
    if (el.isContentEditable) return true;
    if (el.hasAttribute('onclick')) return true;
    try { if (cs(el).cursor === 'pointer') return true; } catch (e) { /* noop */ }
    return false;
  }

  function isFocusable(el) {
    if (el.hasAttribute('tabindex')) return true;
    if (el.disabled) return false;
    var tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href');
    return ['button', 'input', 'select', 'textarea', 'iframe', 'summary', 'audio', 'video'].indexOf(tag) !== -1;
  }

  var TEXT_INPUT_TYPES = ['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date',
    'datetime-local', 'month', 'week', 'time'];

  function isEditable(el) {
    if (el.isContentEditable) return true;
    var tag = el.tagName.toLowerCase();
    if (tag === 'textarea') return !el.disabled && !el.readOnly;
    if (tag === 'input') {
      var t = (el.getAttribute('type') || 'text').toLowerCase();
      return !el.disabled && !el.readOnly && TEXT_INPUT_TYPES.indexOf(t) !== -1;
    }
    var role = getRole(el);
    return role === 'textbox' || role === 'searchbox';
  }

  /* ---------- 敏感字段 ---------- */

  var SENSITIVE_RE = /(pass(word|wd)?|pwd|secret|token|credit|card[_-]?num|cvv|cvc|ssn|id[_-]?card|otp|验证码|密码|身份证|银行卡)/i;

  function isSensitiveField(el) {
    var tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'password') return true;
      var probe = (el.getAttribute('name') || '') + ' ' + (el.id || '') +
        ' ' + (el.getAttribute('autocomplete') || '') + ' ' + (el.getAttribute('placeholder') || '');
      if (SENSITIVE_RE.test(probe)) return true;
      if (/^(cc-|current-password|new-password)/i.test(el.getAttribute('autocomplete') || '')) return true;
    }
    if (tag === 'textarea') {
      var p2 = (el.getAttribute('name') || '') + ' ' + (el.id || '') + ' ' + (el.getAttribute('placeholder') || '');
      if (SENSITIVE_RE.test(p2)) return true;
    }
    return false;
  }

  /* ---------- 属性采集 ---------- */

  var NATIVE_ATTRS = ['id', 'class', 'name', 'type', 'value', 'title', 'href', 'src', 'srcset', 'alt',
    'placeholder', 'target', 'rel', 'disabled', 'readonly', 'required', 'checked', 'selected', 'multiple',
    'maxlength', 'minlength', 'min', 'max', 'step', 'pattern', 'autocomplete', 'autofocus', 'for', 'action',
    'method', 'enctype', 'role', 'tabindex', 'lang', 'dir', 'style', 'width', 'height', 'colspan', 'rowspan'];

  function classifyAttr(name) {
    if (name.indexOf('aria-') === 0) return 'aria';
    if (name.indexOf('data-') === 0) return 'data';
    if (name === 'style') return 'inline-style';
    if (name === 'class' || name === 'id') return 'identity';
    if (NATIVE_ATTRS.indexOf(name) !== -1) return 'native';
    return 'custom';
  }

  function collectAttributes(el) {
    var sensitive = isSensitiveField(el);
    var out = [];
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      var v = a.value;
      if (sensitive && a.name.toLowerCase() === 'value') v = '[已脱敏]';
      out.push({ name: a.name, value: v, category: classifyAttr(a.name) });
    }
    return out;
  }

  function collectProperties(el) {
    var p = {};
    var tag = el.tagName.toLowerCase();
    var sensitive = isSensitiveField(el);
    if ('value' in el && el.value !== undefined) p.value = sensitive ? '[已脱敏]' : truncate(String(el.value), 2000);
    if ('checked' in el) p.checked = !!el.checked;
    if ('selected' in el && tag === 'option') p.selected = !!el.selected;
    if ('disabled' in el) p.disabled = !!el.disabled;
    if ('readOnly' in el) p.readOnly = !!el.readOnly;
    if ('required' in el) p.required = !!el.required;
    if ('multiple' in el) p.multiple = !!el.multiple;
    if ('selectedIndex' in el) p.selectedIndex = el.selectedIndex;
    if ('href' in el && el.href) p.href = String(el.href);
    if ('src' in el && el.src) p.src = String(el.src);
    p.textContentLength = (el.textContent || '').length;
    p.childElementCount = el.childElementCount;
    p.isConnected = el.isConnected;
    p.isContentEditable = !!el.isContentEditable;
    p.tabIndex = el.tabIndex;
    return p;
  }
  /* =========================================================
   * 二、定位器生成与验证
   * ========================================================= */

  var AUTO_VALUE_RE = /^(ember|ext-gen|yui_|react-|radix-|mui-|headlessui-|rc[-_]|ant-|el-|vue-|svelte-|:r|downshift-)/i;
  var HASH_VALUE_RE = /^[0-9a-f]{6,}$/i;

  function isAutoGenerated(v) {
    if (!v) return false;
    if (v.length > 48) return true;
    if (/^\d+$/.test(v)) return true;
    if (AUTO_VALUE_RE.test(v)) return true;
    if (HASH_VALUE_RE.test(v)) return true;
    if (/\d{6,}/.test(v)) return true;
    return false;
  }

  function goodClasses(el) {
    var out = [];
    var list = Array.from(el.classList || []);
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c || c.length > 40) continue;
      if (AUTO_VALUE_RE.test(c)) continue;
      if (/^[a-z0-9]{6,}$/i.test(c) && /\d/.test(c) && !/[_-]/.test(c)) continue;
      out.push(c);
    }
    return out;
  }

  function safeQuery(scope, sel) {
    try {
      var list = scope.querySelectorAll(sel);
      return Array.prototype.slice.call(list);
    } catch (e) {
      return null;
    }
  }

  function uniqueIn(scope, sel) {
    var list = safeQuery(scope, sel);
    if (!list || list.length !== 1) return null;
    return list[0];
  }

  function simpleSeg(el) {
    var tag = el.tagName.toLowerCase();
    if (el.id && !isAutoGenerated(el.id)) return tag + '#' + cssEsc(el.id);
    var cls = goodClasses(el).slice(0, 2);
    return tag + (cls.length ? '.' + cls.map(cssEsc).join('.') : '');
  }

  function parentNodeOf(el) {
    var p = el.parentElement;
    if (p) return p;
    var pn = el.parentNode;
    return (pn && pn.nodeType === 11) ? pn : null;
  }

  function nthOfTypeSeg(el) {
    var s = simpleSeg(el);
    var parent = parentNodeOf(el);
    if (!parent || !parent.children) return s;
    var same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === el.tagName; });
    if (same.length > 1) return s + ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
    return s;
  }

  function elementChain(el) {
    var chain = [];
    var cur = el;
    var guard = 0;
    while (cur && cur.nodeType === 1 && guard++ < 400) {
      chain.unshift(cur);
      if (cur === cur.ownerDocument.documentElement) break;
      cur = cur.parentElement || (cur.parentNode && cur.parentNode.host) || null;
    }
    return chain;
  }

  function shortestUniquePath(el) {
    var chain = elementChain(el);
    var scope = getScope(el);
    for (var i = 0; i < chain.length; i++) {
      var parts = [];
      for (var j = i; j < chain.length; j++) parts.push(nthOfTypeSeg(chain[j]));
      var sel = parts.join(' > ');
      if (uniqueIn(scope, sel) === el) return sel;
    }
    return null;
  }

  function fullNthPath(el) {
    return elementChain(el).map(nthOfTypeSeg).join(' > ');
  }

  function cssCandidates(el) {
    var scope = getScope(el);
    var tag = el.tagName.toLowerCase();
    var out = [];
    var push = function (selector, kind, label, stability) {
      for (var i = 0; i < out.length; i++) if (out[i].selector === selector) return;
      out.push({ selector: selector, kind: kind, label: label, stability: stability });
    };

    // 1. ID
    if (el.id) {
      var idSel = '#' + cssEsc(el.id);
      var hits = safeQuery(scope, idSel);
      if (hits && hits.indexOf(el) !== -1) {
        push(idSel, 'id', 'ID 选择器', isAutoGenerated(el.id) ? 'fragile' : 'stable');
      }
    }

    // 仅收录在当前 scope 内至少能匹配到节点的选择器，避免产生纯噪声候选
    var hit = function (sel) {
      var list = safeQuery(scope, sel);
      return !!(list && list.length);
    };

    // 2. 测试专用属性
    var testAttrs = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'data-automation-id'];
    for (var i = 0; i < testAttrs.length; i++) {
      var tv = el.getAttribute(testAttrs[i]);
      if (tv) {
        var tSel = '[' + testAttrs[i] + '="' + attrVal(tv) + '"]';
        if (hit(tSel)) push(tSel, 'testid', '测试属性选择器', isAutoGenerated(tv) ? 'fragile' : 'stable');
      }
    }

    // 3. name
    var name = el.getAttribute('name');
    if (name) {
      var nSel = tag + '[name="' + attrVal(name) + '"]';
      if (!hit(nSel)) nSel = '[name="' + attrVal(name) + '"]';
      if (hit(nSel)) push(nSel, 'name', 'name 属性选择器', isAutoGenerated(name) ? 'fragile' : 'stable');
    }

    // 4. 语义属性
    var attrPairs = [
      ['aria-label', 'aria-label'],
      ['placeholder', 'placeholder'],
      ['title', 'title'],
      ['alt', 'alt'],
      ['role', 'role']
    ];
    for (var k = 0; k < attrPairs.length; k++) {
      var av = el.getAttribute(attrPairs[k][0]);
      if (!av || av.length > 60) continue;
      var aSel = tag + '[' + attrPairs[k][0] + '="' + attrVal(av) + '"]';
      if (hit(aSel)) push(aSel, 'attr', attrPairs[k][1] + ' 属性选择器', isAutoGenerated(av) ? 'fragile' : 'stable');
    }

    // 5. class
    var cls = goodClasses(el);
    if (cls.length === 1) {
      var c1 = tag + '.' + cssEsc(cls[0]);
      if (hit(c1)) push(c1, 'class', 'Class 选择器', 'semi');
    }
    if (cls.length > 1) {
      var c2 = tag + '.' + cls.slice(0, 2).map(cssEsc).join('.');
      if (hit(c2)) push(c2, 'class', '组合 Class 选择器', 'semi');
      var c3 = '.' + cls.slice(0, 2).map(cssEsc).join('.');
      if (hit(c3)) push(c3, 'class', '组合 Class 选择器', 'semi');
    }

    // 6. 最短唯一层级路径
    var shortPath = shortestUniquePath(el);
    if (shortPath) push(shortPath, 'path', '层级选择器（最短唯一）', 'structural');

    // 7. 完整 nth-of-type 路径
    var nthPath = fullNthPath(el);
    if (nthPath !== shortPath) push(nthPath, 'nth-path', 'nth-of-type 完整层级', 'structural');

    return out;
  }

  function verifyCss(selector, el) {
    var scope = getScope(el);
    var list = safeQuery(scope, selector);
    if (list === null) {
      return { error: '选择器语法错误', count: 0, verified: false, targetMatch: false, unique: false };
    }
    var idx = list.indexOf(el);
    return {
      count: list.length,
      verified: list.length > 0,
      unique: list.length === 1 && list[0] === el,
      targetMatch: idx !== -1,
      firstIsTarget: list.length > 0 && list[0] === el,
      firstVisible: list.length ? isVisible(list[0]) : false
    };
  }

  function absoluteXPath(el) {
    var parts = [];
    var cur = el;
    var guard = 0;
    while (cur && cur.nodeType === 1 && guard++ < 400) {
      var idx = 1;
      var s = cur.previousElementSibling;
      while (s) { if (s.tagName === cur.tagName) idx++; s = s.previousElementSibling; }
      parts.unshift(cur.tagName.toLowerCase() + '[' + idx + ']');
      if (cur === cur.ownerDocument.documentElement) break;
      cur = cur.parentElement || (cur.parentNode && cur.parentNode.host) || null;
    }
    return '/' + parts.join('/');
  }

  function tailSegments(el, anchor) {
    var parts = [];
    var node = el;
    var guard = 0;
    while (node && node !== anchor && node.nodeType === 1 && guard++ < 400) {
      var idx = 1;
      var s = node.previousElementSibling;
      while (s) { if (s.tagName === node.tagName) idx++; s = s.previousElementSibling; }
      parts.unshift(node.tagName.toLowerCase() + '[' + idx + ']');
      node = node.parentElement || (node.parentNode && node.parentNode.host) || null;
    }
    return parts;
  }

  function relativeXPath(el) {
    var cur = el.parentElement;
    var guard = 0;
    while (cur && cur.nodeType === 1 && guard++ < 400) {
      if (cur.id && uniqueIn(getScope(cur), '#' + cssEsc(cur.id)) === cur) {
        var parts = tailSegments(el, cur);
        if (!parts.length) return null;
        return '//*[@id=' + xpathStr(cur.id) + ']/' + parts.join('/');
      }
      cur = cur.parentElement || (cur.parentNode && cur.parentNode.host) || null;
    }
    return null;
  }

  function xpathCandidates(el) {
    var tag = el.tagName.toLowerCase();
    var out = [];
    var push = function (xp, kind, label, stability) {
      for (var i = 0; i < out.length; i++) if (out[i].xpath === xp) return;
      out.push({ xpath: xp, kind: kind, label: label, stability: stability });
    };

    if (el.id) {
      push('//*[@id=' + xpathStr(el.id) + ']', 'id', '基于 ID 的 XPath', isAutoGenerated(el.id) ? 'fragile' : 'stable');
    }
    var testAttrs = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];
    for (var i = 0; i < testAttrs.length; i++) {
      var tv = el.getAttribute(testAttrs[i]);
      if (tv) push('//' + tag + '[@' + testAttrs[i] + '=' + xpathStr(tv) + ']', 'testid', '基于测试属性的 XPath', 'stable');
    }
    var name = el.getAttribute('name');
    if (name) push('//' + tag + '[@name=' + xpathStr(name) + ']', 'name', '基于 name 的 XPath', 'stable');

    ['aria-label', 'placeholder', 'title', 'alt'].forEach(function (a) {
      var v = el.getAttribute(a);
      if (v && v.length <= 60) push('//' + tag + '[@' + a + '=' + xpathStr(v) + ']', 'attr', '基于 ' + a + ' 的 XPath', 'stable');
    });

    var text = normText(el.innerText || el.textContent || '');
    if (text && text.length <= 40) {
      push('//' + tag + '[normalize-space(.)=' + xpathStr(text) + ']', 'text', '基于文本的 XPath', 'semi');
    }

    var rel = relativeXPath(el);
    if (rel) push(rel, 'relative', '相对 XPath（祖先锚定）', 'structural');

    push(absoluteXPath(el), 'absolute', '绝对 XPath', 'fragile');
    return out;
  }

  function xpathContext(el) {
    var root = el.getRootNode();
    if (root && root.nodeType === 11 && root.host) return root;
    return el.ownerDocument;
  }

  function verifyXPath(xp, el) {
    var doc = el.ownerDocument;
    var ctx = xpathContext(el);
    try {
      var res = doc.evaluate(xp, ctx, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      var list = [];
      for (var i = 0; i < res.snapshotLength; i++) list.push(res.snapshotItem(i));
      var idx = list.indexOf(el);
      return {
        count: list.length,
        verified: list.length > 0,
        unique: list.length === 1 && list[0] === el,
        targetMatch: idx !== -1,
        firstIsTarget: list.length > 0 && list[0] === el,
        firstVisible: list.length ? isVisible(list[0]) : false
      };
    } catch (e) {
      var inShadow = !!(ctx && ctx.nodeType === 11);
      return {
        error: inShadow
          ? '浏览器不允许在 Shadow DOM 内部求值 XPath，请改用 shadowRoot 范围内的 CSS 或 Playwright 定位'
          : 'XPath 在该上下文无法求值',
        count: 0, verified: false, targetMatch: false, unique: false
      };
    }
  }

  /* ---------- Playwright 语义模拟 ---------- */

  var SCAN = {
    scope: null, list: null,
    roles: new WeakMap(), names: new WeakMap(), texts: new WeakMap(), labels: new WeakMap()
  };

  function resetScan() {
    SCAN.scope = null;
    SCAN.list = null;
    SCAN.roles = new WeakMap();
    SCAN.names = new WeakMap();
    SCAN.texts = new WeakMap();
    SCAN.labels = new WeakMap();
  }

  function deepElements(scope) {
    if (SCAN.scope === scope && SCAN.list) return SCAN.list;
    SCAN.scope = scope;
    SCAN.list = collectDeepElements(scope);
    return SCAN.list;
  }

  function roleOf(el) {
    if (!SCAN.roles.has(el)) SCAN.roles.set(el, getRole(el));
    return SCAN.roles.get(el);
  }

  function nameOf(el) {
    if (!SCAN.names.has(el)) SCAN.names.set(el, normText(getAccessibleName(el)));
    return SCAN.names.get(el);
  }

  function textOf(el) {
    if (!SCAN.texts.has(el)) SCAN.texts.set(el, normText(rawText(el)));
    return SCAN.texts.get(el);
  }

  function labelOf(el) {
    if (!SCAN.labels.has(el)) SCAN.labels.set(el, normText(getLabelText(el) || el.getAttribute('aria-label') || ''));
    return SCAN.labels.get(el);
  }

  function matchByRole(el, role, name) {
    if (roleOf(el) !== role) return false;
    if (!name) return true;
    return nameOf(el).toLowerCase() === normText(name).toLowerCase();
  }

  function matchByText(el, text) {
    return textOf(el).toLowerCase() === normText(text).toLowerCase();
  }

  function matchByLabel(el, label) {
    return labelOf(el).toLowerCase() === normText(label).toLowerCase();
  }

  function matchByPlaceholder(el, ph) {
    return (el.getAttribute('placeholder') || '').toLowerCase() === ph.toLowerCase();
  }

  function matchByTestId(el, id) {
    return el.getAttribute('data-testid') === id;
  }

  function scanMatch(scope, matcher) {
    var all = deepElements(scope);
    var hits = [];
    for (var i = 0; i < all.length; i++) {
      try { if (matcher(all[i])) hits.push(all[i]); } catch (e) { /* 跳过异常节点 */ }
    }
    return hits;
  }

  function semanticVerify(scope, el, matcher) {
    var hits = scanMatch(scope, matcher);
    return {
      count: hits.length,
      verified: hits.length > 0,
      unique: hits.length === 1 && hits[0] === el,
      targetMatch: hits.indexOf(el) !== -1,
      firstIsTarget: hits.length > 0 && hits[0] === el,
      firstVisible: hits.length ? isVisible(hits[0]) : false,
      method: 'emulated'
    };
  }

  function playwrightCandidates(el) {
    var scope = getScope(el);
    var out = [];
    var role = getRole(el);
    var name = getAccessibleName(el);
    var nameStable = !!(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') ||
      (el.labels && el.labels.length) || el.hasAttribute('data-testid'));
    var add = function (obj) { out.push(obj); };

    if (role) {
      var expr = name && name.length <= 60
        ? 'page.getByRole(' + jsStr(role) + ', { name: ' + jsStr(name) + ', exact: true })'
        : 'page.getByRole(' + jsStr(role) + ')';
      add({
        kind: 'role',
        label: 'getByRole',
        expr: expr,
        stability: nameStable ? 'stable' : 'semi',
        verify: semanticVerify(scope, el, function (n) { return matchByRole(n, role, name); })
      });
    }

    var text = normText(rawText(el));
    if (text && text.length <= 60 && el.children.length === 0) {
      add({
        kind: 'text',
        label: 'getByText',
        expr: 'page.getByText(' + jsStr(text) + ', { exact: true })',
        stability: 'semi',
        verify: semanticVerify(scope, el, function (n) { return matchByText(n, text); })
      });
    }

    var label = normText(getLabelText(el) || el.getAttribute('aria-label') || '');
    if (label && label.length <= 60) {
      add({
        kind: 'label',
        label: 'getByLabel',
        expr: 'page.getByLabel(' + jsStr(label) + ', { exact: true })',
        stability: el.getAttribute('aria-label') ? 'stable' : 'semi',
        verify: semanticVerify(scope, el, function (n) { return matchByLabel(n, label); })
      });
    }

    var ph = el.getAttribute('placeholder');
    if (ph) {
      add({
        kind: 'placeholder',
        label: 'getByPlaceholder',
        expr: 'page.getByPlaceholder(' + jsStr(ph) + ')',
        stability: 'stable',
        verify: semanticVerify(scope, el, function (n) { return matchByPlaceholder(n, ph); })
      });
    }

    var tid = el.getAttribute('data-testid');
    if (tid) {
      add({
        kind: 'testid',
        label: 'getByTestId',
        expr: 'page.getByTestId(' + jsStr(tid) + ')',
        stability: 'stable',
        verify: semanticVerify(scope, el, function (n) { return matchByTestId(n, tid); })
      });
    }

    var bestCss = null;
    var cands = cssCandidates(el);
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      if (c.stability === 'stable' || c.stability === 'semi') { bestCss = c.selector; break; }
    }
    if (!bestCss && cands.length) bestCss = cands[0].selector;
    if (bestCss) {
      add({
        kind: 'locator',
        label: 'locator',
        expr: 'page.locator(' + jsStr(bestCss) + ')',
        stability: 'semi',
        verify: verifyCss(bestCss, el)
      });
    }
    return out;
  }

  function seleniumCandidates(el) {
    var tag = el.tagName.toLowerCase();
    var out = [];
    var scope = getScope(el);

    if (el.id) {
      out.push({
        kind: 'id', label: 'By.ID',
        expr: 'driver.findElement(By.ID, ' + jsStr(el.id) + ')',
        stability: isAutoGenerated(el.id) ? 'fragile' : 'stable',
        verify: verifyCss('[id="' + attrVal(el.id) + '"]', el)
      });
    }
    var name = el.getAttribute('name');
    if (name) {
      out.push({
        kind: 'name', label: 'By.NAME',
        expr: 'driver.findElement(By.NAME, ' + jsStr(name) + ')',
        stability: isAutoGenerated(name) ? 'fragile' : 'stable',
        verify: verifyCss(tag + '[name="' + attrVal(name) + '"]', el)
      });
    }
    var cands = cssCandidates(el);
    var cssPick = null;
    for (var i = 0; i < cands.length; i++) {
      if (cands[i].stability === 'stable' || cands[i].stability === 'semi') { cssPick = cands[i]; break; }
    }
    if (!cssPick) cssPick = cands[0];
    if (cssPick) {
      out.push({
        kind: 'css', label: 'By.CSS_SELECTOR',
        expr: 'driver.findElement(By.CSS_SELECTOR, ' + jsStr(cssPick.selector) + ')',
        stability: cssPick.stability,
        verify: verifyCss(cssPick.selector, el)
      });
    }
    var xps = xpathCandidates(el);
    var xpPick = null;
    for (var j = 0; j < xps.length; j++) {
      var vr = verifyXPath(xps[j].xpath, el);
      if (vr.targetMatch && vr.count === 1 && xps[j].stability !== 'fragile') { xpPick = { c: xps[j], v: vr }; break; }
    }
    if (!xpPick) {
      for (var m = 0; m < xps.length; m++) {
        var v2 = verifyXPath(xps[m].xpath, el);
        if (v2.targetMatch) { xpPick = { c: xps[m], v: v2 }; break; }
      }
    }
    if (xpPick) {
      out.push({
        kind: 'xpath', label: 'By.XPATH',
        expr: 'driver.findElement(By.XPATH, ' + jsStr(xpPick.c.xpath) + ')',
        stability: xpPick.c.stability,
        verify: xpPick.v
      });
    }
    return out;
  }

  function gradeOf(stability, verify) {
    if (!verify || !verify.verified || verify.count === 0 || !verify.targetMatch) return 'FAIL';
    if (verify.count > 1) return 'D';
    if (stability === 'fragile') return 'D';
    if (stability === 'stable') return 'A';
    if (stability === 'structural') return 'C';
    return 'B';
  }

  function buildLocators(el) {
    var rows = [];

    cssCandidates(el).forEach(function (c) {
      rows.push({
        framework: 'css', kind: c.kind, label: c.label, expr: c.selector,
        stability: c.stability, verify: verifyCss(c.selector, el), method: 'native'
      });
    });

    xpathCandidates(el).forEach(function (c) {
      rows.push({
        framework: 'xpath', kind: c.kind, label: c.label, expr: c.xpath,
        stability: c.stability, verify: verifyXPath(c.xpath, el), method: 'native'
      });
    });

    playwrightCandidates(el).forEach(function (c) {
      rows.push({
        framework: 'playwright', kind: c.kind, label: c.label, expr: c.expr,
        stability: c.stability, verify: c.verify, method: 'emulated'
      });
    });

    seleniumCandidates(el).forEach(function (c) {
      rows.push({
        framework: 'selenium', kind: c.kind, label: c.label, expr: c.expr,
        stability: c.stability, verify: c.verify, method: 'native'
      });
    });

    rows.forEach(function (r) {
      r.count = r.verify.count || 0;
      r.unique = !!r.verify.unique;
      r.targetMatch = !!r.verify.targetMatch;
      r.visible = r.verify.count > 0 ? !!r.verify.firstVisible : false;
      r.verified = !!r.verify.verified;
      r.grade = gradeOf(r.stability, r.verify);
      if (r.verify.error) r.note = r.verify.error;
      else if (!r.verified) r.note = '未匹配到任何元素';
      else if (!r.targetMatch) r.note = '匹配到的不是目标节点';
      else if (r.count > 1) r.note = '存在 ' + r.count + ' 个匹配，需进一步收窄';
    });

    return rows;
  }

  var GRADE_ORDER = { A: 0, B: 1, C: 2, D: 3, FAIL: 4 };

  function pickBest(rows, framework) {
    var list = rows.filter(function (r) { return r.framework === framework; });
    if (!list.length) return null;
    list.sort(function (a, b) { return GRADE_ORDER[a.grade] - GRADE_ORDER[b.grade]; });
    return list[0];
  }

  function overallGrade(rows) {
    var best = 'FAIL';
    rows.forEach(function (r) {
      if (GRADE_ORDER[r.grade] < GRADE_ORDER[best]) best = r.grade;
    });
    return best;
  }
  /* =========================================================
   * 三、DOM 结构、遮挡、相似元素、信息包
   * ========================================================= */

  function rawText(el) {
    try {
      if (typeof el.innerText === 'string' && el.innerText) return el.innerText;
    } catch (e) { /* noop */ }
    return el.textContent || '';
  }

  function elementSummary(el, maxText) {
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: Array.from(el.classList || []),
      text: truncate(normText(rawText(el)), maxText || 40),
      visible: isVisible(el),
      interactive: isInteractive(el),
      descriptor: describeShort(el)
    };
  }

  function selectorFor(el) {
    var scope = getScope(el);
    if (el.id) {
      var s = '#' + cssEsc(el.id);
      if (uniqueIn(scope, s) === el) return s;
    }
    var p = shortestUniquePath(el);
    return p || simpleSeg(el);
  }

  function collectParents(el) {
    var out = [];
    var cur = el.parentElement || (el.parentNode && el.parentNode.host) || null;
    var level = 1;
    var guard = 0;
    while (cur && cur.nodeType === 1 && guard++ < 40) {
      out.push({
        level: level++,
        tag: cur.tagName.toLowerCase(),
        id: cur.id || null,
        classes: Array.from(cur.classList || []).slice(0, 6),
        selector: selectorFor(cur),
        role: getRole(cur) || null,
        text: truncate(normText(rawText(cur)), 60),
        visible: isVisible(cur),
        childCount: cur.childElementCount,
        el: cur
      });
      cur = cur.parentElement || (cur.parentNode && cur.parentNode.host) || null;
    }
    return out;
  }

  function collectSiblings(el) {
    var parent = parentNodeOf(el);
    var all = parent && parent.children ? Array.prototype.slice.call(parent.children) : [el];
    if (all.indexOf(el) === -1) all = [el];
    var idx = all.indexOf(el);
    var sameType = all.filter(function (c) { return c.tagName === el.tagName; });
    return {
      total: all.length,
      index: idx + 1,
      typeTotal: sameType.length,
      typeIndex: sameType.indexOf(el) + 1,
      previous: idx > 0 ? elementSummary(all[idx - 1], 30) : null,
      next: idx > -1 && idx < all.length - 1 ? elementSummary(all[idx + 1], 30) : null,
      items: all.slice(0, 60).map(function (c, i) {
        var s = elementSummary(c, 30);
        s.index = i + 1;
        s.isTarget = c === el;
        s.el = c;
        return s;
      })
    };
  }

  function collectChildren(el, maxDepth, budget) {
    maxDepth = maxDepth || 3;
    budget = budget || 300;
    var used = { n: 0 };

    function walk(parent, depth) {
      if (depth > maxDepth || used.n >= budget) return [];
      var kids = Array.prototype.slice.call(parent.children);
      var limit = depth === 1 ? 40 : 12;
      var nodes = [];
      for (var i = 0; i < kids.length && i < limit && used.n < budget; i++) {
        var c = kids[i];
        used.n++;
        var node = elementSummary(c, 30);
        node.childCount = c.childElementCount;
        node.el = c;
        node.children = walk(c, depth + 1);
        nodes.push(node);
      }
      if (kids.length > limit) nodes.push({ tag: '…', text: '另有 ' + (kids.length - limit) + ' 个同级子元素未展开', truncated: true });
      return nodes;
    }

    return {
      count: el.childElementCount,
      maxDepth: maxDepth,
      truncated: used.n >= budget,
      items: walk(el, 1)
    };
  }

  function domPathSegments(el) {
    return elementChain(el).map(function (node) {
      var tag = node.tagName.toLowerCase();
      if (node.id) return tag + '#' + cssEsc(node.id);
      var cls = Array.from(node.classList || []).slice(0, 2).map(cssEsc).join('.');
      var parent = node.parentElement;
      var same = parent ? Array.prototype.filter.call(parent.children, function (c) { return c.tagName === node.tagName; }) : [node];
      var pos = same.length > 1 ? ':nth-of-type(' + (same.indexOf(node) + 1) + ')' : '';
      return tag + (cls ? '.' + cls : '') + pos;
    });
  }

  /* ---------- 遮挡检测 ---------- */

  // 命中元素是否就是目标：命中 Shadow DOM 内部时，document 级命中测试返回的是宿主
  function hitIsTarget(el, top) {
    if (!top) return false;
    if (top === el) return true;
    if (el.contains && el.contains(top)) return true;
    var root = el.getRootNode ? el.getRootNode() : null;
    var guard = 0;
    while (root && root.nodeType === 11 && root.host && guard++ < 20) {
      if (top === root.host) return true;
      root = root.host.getRootNode();
    }
    return false;
  }

  function hitTest(el) {
    var doc = el.ownerDocument;
    var win = doc.defaultView || window;
    var r = el.getBoundingClientRect();
    var result = {
      inViewport: false,
      samples: 0,
      hitSamples: 0,
      coverRatio: 0,
      centerCovered: false,
      centerBlockedBy: null,
      blockers: []
    };
    if (r.width <= 0 || r.height <= 0) {
      result.note = '元素尺寸为 0，无法进行命中检测';
      return result;
    }
    var vw = win.innerWidth, vh = win.innerHeight;
    var visibleW = Math.min(r.right, vw) - Math.max(r.left, 0);
    var visibleH = Math.min(r.bottom, vh) - Math.max(r.top, 0);
    if (visibleW <= 0 || visibleH <= 0) {
      result.note = '元素不在当前视口内，需滚动后才能检测遮挡';
      return result;
    }
    result.inViewport = true;

    var inset = Math.min(2, r.width / 6, r.height / 6);
    var left = Math.max(r.left + inset, 0), right = Math.min(r.right - inset, vw);
    var top = Math.max(r.top + inset, 0), bottom = Math.min(r.bottom - inset, vh);
    var cols = 5, rows = 5;
    var blockerMap = {};

    function probe(x, y) {
      if (x < 0 || y < 0 || x > vw - 1 || y > vh - 1) return null;
      var stack;
      try { stack = doc.elementsFromPoint(x, y); } catch (e) { return null; }
      if (!stack || !stack.length) return null;
      var top = null;
      for (var i = 0; i < stack.length; i++) {
        if (isOwnUi(stack[i])) continue; // 忽略本工具自身的面板
        top = stack[i];
        break;
      }
      if (!top) return null;
      // 只有最顶层命中元素确实是目标（或目标的影子宿主），才算该点能真正点到目标
      return { ok: hitIsTarget(el, top), top: top };
    }

    var cx = Math.min(Math.max(r.left + r.width / 2, 0), vw - 1);
    var cy = Math.min(Math.max(r.top + r.height / 2, 0), vh - 1);
    var center = probe(cx, cy);
    if (center) {
      result.centerCovered = !center.ok;
      result.centerBlockedBy = center.ok ? null : describeShort(center.top);
    }

    for (var i = 0; i < cols; i++) {
      for (var j = 0; j < rows; j++) {
        var x = left + (right - left) * (cols === 1 ? 0.5 : i / (cols - 1));
        var y = top + (bottom - top) * (rows === 1 ? 0.5 : j / (rows - 1));
        var p = probe(x, y);
        if (!p) continue;
        result.samples++;
        if (p.ok) result.hitSamples++;
        else {
          var d = describeShort(p.top);
          blockerMap[d] = (blockerMap[d] || 0) + 1;
        }
      }
    }
    result.coverRatio = result.samples ? +(1 - result.hitSamples / result.samples).toFixed(3) : 0;
    if (!result.samples) result.note = '未能在元素区域内取得采样点，遮挡结论不可用（可能被完全裁切）';
    result.blockers = Object.keys(blockerMap).map(function (k) { return { element: k, points: blockerMap[k] }; })
      .sort(function (a, b) { return b.points - a.points; }).slice(0, 6);

    // 逐级检查 iframe 容器是否在父页面被遮挡
    var frameBlocked = [];
    var frameEl = null;
    try { frameEl = el.ownerDocument.defaultView.frameElement; } catch (e) { frameEl = null; }
    var guard = 0;
    while (frameEl && guard++ < 10) {
      var pdoc = frameEl.ownerDocument;
      var pwin = pdoc.defaultView;
      var fr = frameEl.getBoundingClientRect();
      var fx = fr.left + fr.width / 2, fy = fr.top + fr.height / 2;
      var okFrame = false, blockEl = null;
      if (fx >= 0 && fy >= 0 && fx < pwin.innerWidth && fy < pwin.innerHeight) {
        var st = [];
        try { st = pdoc.elementsFromPoint(fx, fy); } catch (e) { st = []; }
        for (var s = 0; s < st.length; s++) {
          if (st[s] === frameEl) { okFrame = true; break; }
        }
        if (!okFrame && st.length) blockEl = st[0];
      }
      if (!okFrame) frameBlocked.push({ element: blockEl ? describeShort(blockEl) : '未知元素', reason: 'iframe 容器在父页面被遮挡' });
      try { frameEl = pwin.frameElement; } catch (e) { frameEl = null; }
    }
    if (frameBlocked.length) result.frameBlockers = frameBlocked;
    return result;
  }

  /* ---------- 相似元素 ---------- */

  function itemContainer(el) {
    var cur = el;
    var guard = 0;
    while (cur && cur.parentElement && guard++ < 8) {
      var tag = cur.tagName.toLowerCase();
      var role = getRole(cur);
      if (tag === 'li' || tag === 'tr' || tag === 'article' || role === 'listitem' || role === 'row' ||
        cur.hasAttribute('data-index') || cur.hasAttribute('data-row-key')) {
        return describeShort(cur);
      }
      cur = cur.parentElement;
    }
    return el.parentElement ? describeShort(el.parentElement) : '';
  }

  function findSimilar(el) {
    var scope = getScope(el);
    var tag = el.tagName.toLowerCase();
    var role = getRole(el);
    var text = normText(rawText(el));
    var clsKey = goodClasses(el).sort().join('.');
    var all = collectDeepElements(scope);
    var hits = [];
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      if (n === el) continue;
      if (n.tagName.toLowerCase() !== tag) continue;
      if (getRole(n) !== role) continue;
      var t = normText(rawText(n));
      if (text && text.length <= 40 && t !== text) continue;
      if (clsKey && goodClasses(n).sort().join('.') !== clsKey) continue;
      hits.push(n);
      if (hits.length >= 40) break;
    }
    if (!hits.length) {
      return { total: 1, index: 1, items: [similarItem(el, 1, true, null)], compared: false };
    }

    var group = hits.concat([el]).sort(function (a, b) {
      if (a === b) return 0;
      var pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    var targetAttrs = {};
    Array.prototype.forEach.call(el.attributes, function (a) { targetAttrs[a.name] = a.value; });

    var items = group.map(function (n, idx) {
      return similarItem(n, idx + 1, n === el, targetAttrs);
    });

    return {
      total: group.length,
      index: group.indexOf(el) + 1,
      compared: true,
      distinctBy: items.filter(function (it) {
        return !it.isTarget && Object.keys(it.diff || {}).length > 0;
      }).length,
      items: items
    };
  }

  function similarItem(el, index, isTarget, targetAttrs) {
    var diff = {};
    if (!isTarget && targetAttrs) {
      var count = 0;
      Array.prototype.forEach.call(el.attributes, function (a) {
        if (count >= 6) return;
        if (targetAttrs[a.name] !== a.value) {
          diff[a.name] = { target: targetAttrs[a.name] === undefined ? null : truncate(targetAttrs[a.name], 40), this: truncate(a.value, 40) };
          count++;
        }
      });
      Object.keys(targetAttrs).forEach(function (name) {
        if (count >= 6) return;
        if (!el.hasAttribute(name)) {
          diff[name] = { target: truncate(targetAttrs[name], 40), this: null };
          count++;
        }
      });
    }
    return {
      index: index,
      isTarget: isTarget,
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: Array.from(el.classList || []).slice(0, 4),
      text: truncate(normText(rawText(el)), 40),
      visible: isVisible(el),
      disabled: !!el.disabled,
      container: itemContainer(el),
      parentChain: elementChain(el).slice(-4).map(function (n) { return describeShort(n); }).join(' > '),
      selector: selectorFor(el),
      diff: diff,
      el: el
    };
  }

  /* ---------- 汇总采集 ---------- */

  function buildReport(el) {
    var style = cs(el);
    var rect = el.getBoundingClientRect();
    var pageRect = absRect(el);
    var occ = hitTest(el);
    var attrs = collectAttributes(el);
    var props = collectProperties(el);
    var locators = buildLocators(el);
    var parents = collectParents(el);
    var siblings = collectSiblings(el);
    var children = collectChildren(el, 3, 300);
    var limited = pageNodeCount() > 12000;
    state.scanLimited = limited;
    var similar = limited ? { total: 0, index: 0, compared: 0, items: [], skipped: true } : findSimilar(el);
    var sensitive = isSensitiveField(el);
    var shadow = shadowChain(el);
    var frames = frameChain(el);
    var visible = isVisible(el);
    var win = el.ownerDocument.defaultView || window;
    var fullText = normText(rawText(el));
    var html = '';
    try { html = el.outerHTML || ''; } catch (e) { html = '[无法读取 outerHTML]'; }

    var report = {
      meta: {
        tool: '网页元素选择器（Agent Element Inspector）',
        version: VERSION,
        url: location.href,
        title: document.title,
        collectedAt: nowISO(),
        userAgent: navigator.userAgent,
        frameChain: frames,
        shadowChain: shadow,
        scope: scopeFlag(el),
        scanLimited: limited
      },
      element: {
        tagName: el.tagName.toLowerCase(),
        id: el.id || null,
        classes: Array.from(el.classList || []),
        role: getRole(el) || null,
        roleSource: el.getAttribute('role') ? 'explicit' : 'implicit',
        accessibleName: getAccessibleName(el),
        text: truncate(fullText, MAX_TEXT_IN_JSON),
        textLength: fullText.length,
        textTruncated: fullText.length > MAX_TEXT_IN_JSON,
        outerHTML: truncate(html, MAX_HTML_IN_JSON),
        outerHTMLLength: html.length,
        outerHTMLTruncated: html.length > MAX_HTML_IN_JSON,
        attributes: attrs,
        properties: props
      },
      dom: {
        path: domPathSegments(el).join(' > '),
        depth: elementChain(el).length,
        parents: parents,
        children: children,
        siblings: siblings,
        previousElementSibling: siblings.previous ? siblings.previous.descriptor : null,
        nextElementSibling: siblings.next ? siblings.next.descriptor : null
      },
      framework: getFrameworkInfo(el),
      context: {
        inside: semanticInside(el),
        visual: visualSummary(el)
      },
      box: {
        viewportRect: { x: +rect.left.toFixed(2), y: +rect.top.toFixed(2), width: +rect.width.toFixed(2), height: +rect.height.toFixed(2) },
        pageRect: { x: +pageRect.x.toFixed(2), y: +pageRect.y.toFixed(2), width: +pageRect.width.toFixed(2), height: +pageRect.height.toFixed(2) },
        viewport: { width: win.innerWidth, height: win.innerHeight },
        scroll: {
          windowX: Math.round(window.scrollX), windowY: Math.round(window.scrollY),
          frameX: Math.round(win.scrollX), frameY: Math.round(win.scrollY)
        },
        inViewport: inViewport(el),
        visibleRatio: visibleRatio(el)
      },
      styles: {
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        pointerEvents: style.pointerEvents,
        position: style.position,
        zIndex: style.zIndex,
        overflow: style.overflow,
        cursor: style.cursor,
        color: style.color,
        backgroundColor: style.backgroundColor,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        transform: style.transform === 'none' ? null : style.transform
      },
      state: {
        visible: visible,
        rendered: isRendered(el),
        inViewport: inViewport(el),
        covered: occ.centerCovered,
        coverRatio: occ.coverRatio,
        clickable: visible && !el.disabled && !occ.centerCovered && style.pointerEvents !== 'none',
        editable: isEditable(el),
        focusable: isFocusable(el),
        interactive: isInteractive(el),
        disabled: !!el.disabled,
        readOnly: !!el.readOnly,
        required: !!el.required,
        checked: typeof el.checked === 'boolean' ? el.checked : null,
        selected: el.tagName === 'OPTION' ? !!el.selected : null,
        ariaHidden: el.getAttribute('aria-hidden'),
        ariaExpanded: el.getAttribute('aria-expanded'),
        ariaSelected: el.getAttribute('aria-selected'),
        ariaChecked: el.getAttribute('aria-checked'),
        ariaDisabled: el.getAttribute('aria-disabled'),
        inert: el.closest ? !!el.closest('[inert]') : false
      },
      occlusion: occ,
      form: {
        tagName: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || null,
        name: el.getAttribute('name') || null,
        value: sensitive ? '[已脱敏]' : ('value' in el ? truncate(String(el.value || ''), 200) : null),
        placeholder: el.getAttribute('placeholder') || null,
        autocomplete: el.getAttribute('autocomplete') || null,
        formAction: el.getAttribute('formaction') || null,
        pattern: el.getAttribute('pattern') || null,
        min: el.getAttribute('min') || null,
        max: el.getAttribute('max') || null,
        step: el.getAttribute('step') || null,
        sensitive: sensitive
      },
      locators: locators,
      recommended: {
        css: (pickBest(locators, 'css') || {}).expr || null,
        xpath: (pickBest(locators, 'xpath') || {}).expr || null,
        playwright: (pickBest(locators, 'playwright') || {}).expr || null,
        selenium: (pickBest(locators, 'selenium') || {}).expr || null
      },
      overallGrade: overallGrade(locators),
      similar: similar,
      warnings: buildWarnings(el, attrs, occ, sensitive, locators)
    };

    report._refs = { el: el, parents: parents, siblings: siblings, children: children, similar: similar, html: html };
    return report;
  }

  function buildWarnings(el, attrs, occ, sensitive, locators) {
    var out = [];
    if (sensitive) out.push('该元素被判定为敏感字段，value 已脱敏，导出前请确认合规性');
    if (occ.centerCovered) out.push('元素中心点被遮挡，直接点击可能命中其他元素');
    if (occ.coverRatio > 0 && !occ.centerCovered) out.push('元素约 ' + Math.round(occ.coverRatio * 100) + '% 的采样点被其他元素覆盖');
    if (occ.frameBlockers && occ.frameBlockers.length) out.push('所属 iframe 在父页面被遮挡，需先处理外层浮层');
    if (!isVisible(el)) out.push('元素当前不可见（display/visibility/opacity/尺寸异常）');
    if (!inViewport(el)) out.push('元素不在当前视口内，操作前需滚动到可见位置');
    var dupId = attrs.filter(function (a) { return a.name === 'id'; })[0];
    if (dupId) {
      var scope = getScope(el);
      var hits = safeQuery(scope, '[id="' + attrVal(dupId.value) + '"]') || [];
      if (hits.length > 1) out.push('页面存在 ' + hits.length + ' 个相同 id，ID 定位不可靠');
    }
    if (scopeFlag(el) === 'shadow') out.push('元素位于 Shadow DOM 内，需从对应宿主 shadowRoot 内查询');
    if (frameChain(el).length) out.push('元素位于 iframe 内，Agent 需切换到对应 frame 上下文');
    var best = pickBest(locators, 'css') || pickBest(locators, 'xpath');
    if (best && best.grade === 'FAIL') out.push('所有定位器均未通过目标一致性验证，请重新选择元素');
    return out;
  }

  /* ---------- Agent 信息包 ---------- */

  function toAgentJson(r) {
    return {
      tool: r.meta.tool,
      version: r.meta.version,
      collectedAt: r.meta.collectedAt,
      page: { url: r.meta.url, title: r.meta.title },
      frameChain: r.meta.frameChain,
      shadowChain: r.meta.shadowChain,
      scope: r.meta.scope,
      scanLimited: r.meta.scanLimited,
      framework: r.framework,
      context: r.context,
      element: {
        tagName: r.element.tagName,
        id: r.element.id,
        classes: r.element.classes,
        role: r.element.role,
        roleSource: r.element.roleSource,
        accessibleName: r.element.accessibleName,
        text: r.element.text,
        textTruncated: r.element.textTruncated,
        outerHTML: r.element.outerHTML,
        outerHTMLTruncated: r.element.outerHTMLTruncated,
        attributes: r.element.attributes.reduce(function (acc, a) { acc[a.name] = a.value; return acc; }, {}),
        attributeList: r.element.attributes,
        properties: r.element.properties
      },
      dom: {
        path: r.dom.path,
        depth: r.dom.depth,
        parents: r.dom.parents.map(function (p) {
          return { level: p.level, tag: p.tag, id: p.id, classes: p.classes, selector: p.selector, text: p.text, visible: p.visible };
        }),
        children: {
          count: r.dom.children.count,
          items: stripRefs(r.dom.children.items)
        },
        siblings: {
          total: r.dom.siblings.total,
          index: r.dom.siblings.index,
          typeTotal: r.dom.siblings.typeTotal,
          typeIndex: r.dom.siblings.typeIndex,
          previous: r.dom.siblings.previous,
          next: r.dom.siblings.next
        }
      },
      box: r.box,
      styles: r.styles,
      state: r.state,
      occlusion: {
        centerCovered: r.occlusion.centerCovered,
        centerBlockedBy: r.occlusion.centerBlockedBy,
        coverRatio: r.occlusion.coverRatio,
        blockers: r.occlusion.blockers,
        frameBlockers: r.occlusion.frameBlockers || null,
        note: r.occlusion.note || null
      },
      form: r.form,
      locators: r.locators.map(function (l) {
        return {
          framework: l.framework,
          type: l.kind,
          label: l.label,
          expression: l.expr,
          matches: l.count,
          unique: l.unique,
          targetMatch: l.targetMatch,
          visible: l.visible,
          verified: l.verified,
          verifyMethod: l.method,
          grade: l.grade,
          note: l.note || null
        };
      }),
      recommended: r.recommended,
      overallGrade: r.overallGrade,
      similar: {
        total: r.similar.total,
        index: r.similar.index,
        compared: r.similar.compared,
        items: (r.similar.items || []).map(function (it) {
          return {
            index: it.index, isTarget: it.isTarget, tag: it.tag, id: it.id, classes: it.classes,
            text: it.text, visible: it.visible, disabled: it.disabled,
            container: it.container, parentChain: it.parentChain, selector: it.selector, diff: it.diff
          };
        })
      },
      warnings: r.warnings
    };
  }

  function stripRefs(nodes) {
    if (!nodes) return [];
    return nodes.map(function (n) {
      var o = {
        tag: n.tag, id: n.id, classes: n.classes, text: n.text,
        visible: n.visible, interactive: n.interactive, childCount: n.childCount,
        truncated: n.truncated || false
      };
      if (n.children && n.children.length) o.children = stripRefs(n.children);
      return o;
    });
  }

  function toCompactJson(r) {
    var bestCss = pickBest(r.locators, 'css');
    var bestXp = pickBest(r.locators, 'xpath');
    var bestPw = pickBest(r.locators, 'playwright');
    var bestSel = pickBest(r.locators, 'selenium');
    var verifies = r.locators.filter(function (l) { return l.verified && l.targetMatch; }).length;
    return {
      tool: 'AEI',
      v: r.meta.version,
      ts: r.meta.collectedAt,
      url: r.meta.url,
      title: r.meta.title,
      element: {
        tag: r.element.tagName,
        id: r.element.id,
        role: r.element.role,
        name: r.element.accessibleName,
        text: truncate(r.element.text, 120),
        classes: r.element.classes.slice(0, 4),
        path: r.dom.path
      },
      locators: {
        css: bestCss ? { expression: bestCss.expr, grade: bestCss.grade, matches: bestCss.count } : null,
        xpath: bestXp ? { expression: bestXp.expr, grade: bestXp.grade, matches: bestXp.count } : null,
        playwright: bestPw ? { expression: bestPw.expr, grade: bestPw.grade, matches: bestPw.count } : null,
        selenium: bestSel ? { expression: bestSel.expr, grade: bestSel.grade, matches: bestSel.count } : null
      },
      verified: {
        totalLocators: r.locators.length,
        passed: verifies,
        unique: r.locators.filter(function (l) { return l.unique; }).length,
        allPassedFail: verifies === 0
      },
      state: {
        visible: r.state.visible,
        inViewport: r.state.inViewport,
        clickable: r.state.clickable,
        covered: r.state.covered,
        coverRatio: r.state.coverRatio,
        editable: r.state.editable,
        focusable: r.state.focusable,
        disabled: r.state.disabled
      },
      box: {
        x: Math.round(r.box.pageRect.x),
        y: Math.round(r.box.pageRect.y),
        w: Math.round(r.box.pageRect.width),
        h: Math.round(r.box.pageRect.height)
      },
      context: {
        parent: r.dom.parents[0] ? r.dom.parents[0].selector : null,
        ancestors: r.dom.parents.slice(0, 3).map(function (p) { return p.selector; }),
        inside: r.context.inside || null,
        visual: r.context.visual || null,
        framework: (r.framework && r.framework.components.length) ? r.framework.components.join(' › ') : null,
        source: (r.framework && r.framework.source) || null,
        siblings: r.dom.siblings.total,
        siblingIndex: r.dom.siblings.index,
        childCount: r.dom.children.count,
        similarCount: r.similar.total,
        similarIndex: r.similar.index,
        inShadow: r.meta.scope === 'shadow',
        frameDepth: r.meta.frameChain.length
      },
      html: truncate(r._refs.html, 1200),
      warnings: r.warnings
    };
  }

  function toPlainText(r) {
    var lines = [];
    lines.push('元素：' + r.element.tagName + (r.element.id ? '#' + r.element.id : '') +
      (r.element.classes.length ? '.' + r.element.classes.join('.') : ''));
    lines.push('语义：role=' + (r.element.role || '-') + '，name=' + (r.element.accessibleName || '-'));
    if (r.context && r.context.inside) lines.push('上下文：' + r.context.inside);
    if (r.context && r.context.visual) lines.push('视觉：' + r.context.visual);
    if (r.framework && r.framework.components && r.framework.components.length) {
      lines.push('组件链：' + r.framework.components.join(' › ') + (r.framework.source ? '（' + r.framework.source + '）' : ''));
    }
    lines.push('文本：' + truncate(r.element.text, 200));
    lines.push('位置：' + r.dom.path);
    lines.push('尺寸：' + Math.round(r.box.pageRect.width) + '×' + Math.round(r.box.pageRect.height) +
      '，页面坐标 (' + Math.round(r.box.pageRect.x) + ',' + Math.round(r.box.pageRect.y) + ')');
    lines.push('状态：可见=' + r.state.visible + '，在视口=' + r.state.inViewport +
      '，可点击=' + r.state.clickable + '，遮挡比例=' + Math.round(r.state.coverRatio * 100) + '%');
    lines.push('推荐定位：');
    lines.push('  CSS: ' + (r.recommended.css || '-'));
    lines.push('  XPath: ' + (r.recommended.xpath || '-'));
    lines.push('  Playwright: ' + (r.recommended.playwright || '-'));
    lines.push('  Selenium: ' + (r.recommended.selenium || '-'));
    lines.push('综合评级：' + r.overallGrade);
    if (r.warnings.length) {
      lines.push('风险提示：');
      r.warnings.forEach(function (w) { lines.push('  - ' + w); });
    }
    return lines.join('\n');
  }

  function toLocatorText(r) {
    var lines = [];
    r.locators.forEach(function (l) {
      lines.push('[' + l.framework.toUpperCase() + '][' + l.grade + '] ' + l.expr +
        '  (匹配 ' + l.count + '，唯一 ' + (l.unique ? '是' : '否') +
        '，命中目标 ' + (l.targetMatch ? '是' : '否') + ')');
    });
    return lines.join('\n');
  }

  /* ---------- 面向 LLM 的提示词（token 经济格式） ---------- */

  function shortVal(v) {
    v = String(v == null ? '' : v);
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return v.slice(0, 8) + '…' + v.slice(-4);
    return v.length > 32 ? v.slice(0, 24) + '…' : v;
  }

  function compactUrl() {
    try {
      var u = new URL(location.href);
      if (location.href.length <= 140 || !u.search) return location.href;
      var parts = [], seen = {};
      u.searchParams.forEach(function (v, k) {
        if (seen[k]) return;
        seen[k] = 1;
        parts.push(k + '=' + shortVal(v));
      });
      return u.origin + u.pathname + (parts.length ? '?' + parts.join('&') : '') + (u.hash || '');
    } catch (e) {
      return location.href;
    }
  }

  function promptLines(items) {
    var lines = ['Page: ' + compactUrl()];
    lines.push('');
    items.forEach(function (it, i) {
      var r = it.report || it;
      if (!r) return;
      var e = r.element;
      var fwInfo = r.framework || {};
      var comps = fwInfo.components || [];
      var kind = comps.length ? comps[comps.length - 1] : (e.role || e.tagName);
      var line = (i + 1) + '. ' + kind + (e.accessibleName ? ' "' + truncate(e.accessibleName, 48) + '"' : '') + ' <' + e.tagName + '>';
      lines.push(line);
      if (r.recommended && r.recommended.css) lines.push('   selector: ' + r.recommended.css);
      if (e.role || e.accessibleName) {
        lines.push('   locator: ' + (e.role || e.tagName) + (e.accessibleName ? ' "' + truncate(e.accessibleName, 48) + '"' : ''));
      }
      if (r.context && r.context.inside) lines.push('   inside: ' + r.context.inside);
      if (comps.length) lines.push('   ' + (fwInfo.library || 'react') + ': ' + comps.join(' › '));
      if (fwInfo.source) lines.push('   source: ' + fwInfo.source);
      if (e.text) lines.push('   text: "' + truncate(normText(e.text), 80) + '"');
      (e.attributes || []).forEach(function (a) {
        if (a && /^data-/.test(a.name) && a.value && String(a.value).length <= 80) {
          lines.push('   ' + a.name + ': ' + truncate(String(a.value), 60));
        }
      });
      if (r.context && r.context.visual) lines.push('   visual: ' + r.context.visual);
      if (r.overallGrade) lines.push('   grade: ' + r.overallGrade);
      if (it.instruction) lines.push('   instruction: ' + it.instruction);
    });
    return lines;
  }

  function toPromptText(r, instruction) {
    return promptLines([{ report: r, instruction: instruction || '' }]).join('\n');
  }

  function toPromptCollection() {
    var items = state.collection.filter(function (it) { return ensureItemReport(it); });
    return promptLines(items).join('\n');
  }

  /* ---------- 框架组件链 ---------- */

  function getFrameworkInfo(el) {
    var out = { library: null, components: [], source: null };
    try {
      var keys = Object.keys(el);
      var rk = null;
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf('__reactFiber$') === 0 || keys[i].indexOf('__reactInternalInstance$') === 0) { rk = keys[i]; break; }
      }
      if (rk) {
        out.library = 'react';
        var node = el[rk], guard = 0;
        while (node && guard++ < 300) {
          if (!out.source && node._debugSource && node._debugSource.fileName) {
            out.source = String(node._debugSource.fileName).replace(/^.*?\/src\//, 'src/') + ':' + node._debugSource.lineNumber;
          }
          if (node.type && typeof node.type === 'function') {
            var name = node.type.displayName || node.type.name;
            if (name && name.length >= 2 && /^[A-Z]/.test(name) && !/^(_|Internal|ForwardRef|Memo|Context|Fragment$|Suspense$|StrictMode$)/.test(name) &&
              out.components.indexOf(name) === -1 && out.components.length < 3) {
              out.components.unshift(name);
            }
          }
          node = node.return;
        }
      }
    } catch (e) { /* 忽略框架内部结构差异 */ }
    if (!out.library) {
      try {
        var vk = Object.keys(el).filter(function (k) { return k.indexOf('__vueParentComponent') === 0; })[0];
        if (vk) {
          out.library = 'vue';
          var c = el[vk], g2 = 0;
          while (c && g2++ < 20) {
            var vn = c.type && (c.type.__name || c.type.name);
            if (vn && out.components.indexOf(vn) === -1 && out.components.length < 3) out.components.unshift(vn);
            c = c.parent;
          }
        }
      } catch (e2) { /* noop */ }
    }
    return out;
  }

  /* ---------- 语义上下文 / 视觉摘要 ---------- */

  function semanticInside(el) {
    var parts = [];
    try {
      var cell = el.closest ? el.closest('td,th') : null;
      if (cell) {
        var header = '';
        if (cell.tagName === 'TD' && cell.cellIndex >= 0) {
          var row = cell.closest('tr');
          var scope = (row && row.parentElement) || cell.closest('table');
          var th = scope ? scope.querySelector('th:nth-child(' + (cell.cellIndex + 1) + ')') : null;
          header = th ? normText(th.textContent) : '';
        }
        parts.push(header ? 'table cell under "' + truncate(header, 24) + '"' : 'table cell');
      }
      if (el.closest && el.closest('li')) parts.push('list item');
      var label = el.closest ? el.closest('label') : null;
      if (label) parts.push('field "' + truncate(normText(label.textContent), 24) + '"');
      else if (el.closest && el.closest('form')) parts.push('form');
      var region = el.closest ? el.closest('dialog,[role="dialog"],[role="menu"],[role="tablist"],nav,aside,header,footer,main,section,article') : null;
      if (region && region !== el) {
        var rn = region.getAttribute('aria-label') || region.getAttribute('title') || '';
        if (!rn) {
          var hd = region.querySelector('h1,h2,h3,h4,h5,h6');
          if (hd) rn = normText(hd.textContent);
        }
        var rrole = getRole(region) || region.tagName.toLowerCase();
        parts.push(rn ? rrole + ' "' + truncate(rn, 24) + '"' : rrole);
      }
    } catch (e) { /* noop */ }
    var seen = {}, out = [];
    parts.forEach(function (p) { if (p && !seen[p]) { seen[p] = 1; out.push(p); } });
    return out.slice(0, 3).join('; ');
  }

  function visualSummary(el) {
    try {
      var s = cs(el);
      var klass = Array.from(el.classList || []).join(' ').toLowerCase();
      var parts = [];
      if (/badge|tag|chip|pill/.test(klass)) parts.push('badge');
      var radius = parseFloat(s.borderRadius) || 0;
      var minSide = Math.min(el.offsetWidth, el.offsetHeight) || 0;
      if (/rounded-full|pill/.test(klass) || (minSide && radius >= minSide / 3)) parts.push('pill');
      else if (radius > 0) parts.push('rounded');
      if (parseFloat(s.borderTopWidth) > 0 || parseFloat(s.borderRightWidth) > 0 ||
        parseFloat(s.borderBottomWidth) > 0 || parseFloat(s.borderLeftWidth) > 0) parts.push('border');
      if (s.backgroundColor && s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent') {
        parts.push('bg ' + s.backgroundColor);
      }
      if (s.boxShadow && s.boxShadow !== 'none') parts.push('shadow');
      if (/text-xs|text-\[(9|10|11|12)px\]/.test(klass)) parts.push('tiny text');
      else if (/text-sm/.test(klass)) parts.push('small text');
      return parts.slice(0, 5).join(', ');
    } catch (e) {
      return '';
    }
  }

  /* ---------- 大页面降级 ---------- */

  var nodeCountCache = 0;
  var nodeCountAt = 0;

  function pageNodeCount() {
    var now = Date.now();
    if (nodeCountAt && now - nodeCountAt < 5000) return nodeCountCache;
    nodeCountAt = now;
    try { nodeCountCache = document.getElementsByTagName('*').length; } catch (e) { nodeCountCache = 0; }
    return nodeCountCache;
  }

  /* ---------- 撤销栈 ---------- */

  var HISTORY_MAX = 30;

  function snapshotState() {
    return {
      current: state.current,
      report: state.report,
      collection: state.collection.slice(),
      tab: state.tab,
      currentRoot: state.currentRoot
    };
  }

  function pushHistory() {
    if (!state.report) return;
    state.history.push(snapshotState());
    if (state.history.length > HISTORY_MAX) state.history.shift();
  }

  function undo() {
    if (!state.history.length) { toast('没有可撤销的操作', true); return; }
    var s = state.history.pop();
    state.current = s.current;
    state.report = s.report;
    state.collection = s.collection;
    state.tab = s.tab;
    state.currentRoot = s.currentRoot;
    state.stale = false;
    state.staleNote = '';
    state.staleInfo = null;
    if (state.current && state.current.isConnected) showHighlight(state.current);
    else hideHighlight();
    applyTab();
    render();
    toast('已撤销');
  }

  /* ---------- 采集列表 ---------- */

  function ensureItemReport(it) {
    if (!it) return null;
    if (it.report) return it.report;
    if (!it.el || !it.el.isConnected) return null;
    try {
      resetScan();
      it.report = buildReport(it.el);
    } catch (e) {
      it.report = null;
    }
    return it.report;
  }

  function addToCollection(el, silent) {
    if (!el || el.nodeType !== 1) return;
    for (var i = 0; i < state.collection.length; i++) {
      if (state.collection[i].el === el) {
        if (!silent) toast('该元素已在采集列表中');
        return;
      }
    }
    state.collection.push({ el: el, report: null, instruction: '' });
    if (!silent) toast('已加入采集列表（' + state.collection.length + ' 个元素）');
  }

  /* =========================================================
   * 四、面板 UI（Shadow DOM 隔离）
   * ========================================================= */

  var state = {
    panelOpen: true,
    collapsed: false,
    picking: false,
    locked: false,
    current: null,
    currentRoot: null,
    report: null,
    stale: false,
    staleNote: '',
    staleInfo: null,
    monitor: null,
    observedRoots: [],
    openSections: { summary: true, locators: true, attrs: false, dom: true, similar: false, agent: true },
    tab: 'agent',
    attrFilter: '',
    collection: [],
    history: [],
    panelPos: null,
    scanLimited: false,
    nodeMap: {}, parentMap: [], siblingMap: [], similarMap: []
  };

  var host = null;
  var shadow = null;
  var ui = {};
  var toastTimer = null;

  var CSS_TEXT = [
    ':host { all: initial; }',
    '.wrap { position: fixed; inset: 0; pointer-events: none; z-index: ' + Z_BASE + ';',
    '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;',
    '  font-size: 12px; line-height: 1.55; color: #e6edf3; text-align: left; }',
    '.panel { position: absolute; top: 10px; right: 10px; width: 424px; max-height: calc(100vh - 20px); z-index: 3;',
    '  display: flex; flex-direction: column; pointer-events: auto; background: #11161d;',
    '  border: 1px solid #2a333f; border-radius: 10px; box-shadow: 0 12px 40px rgba(0,0,0,.55); overflow: hidden; }',
    '.panel.collapsed { width: 236px; }',
    '.panel.collapsed .toolbar, .panel.collapsed .tabs, .panel.collapsed .body, .panel.collapsed .foot { display: none; }',
    '.panel.hidden { display: none; }',
    '.head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: #171e27; border-bottom: 1px solid #2a333f; }',
    '.logo { display: inline-block; padding: 1px 5px; border-radius: 4px; background: #1f6feb; color: #fff; font-size: 10px; font-weight: 700; letter-spacing: .5px; }',
    '.brand { flex: 1; display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: #dbe6f2; overflow: hidden; white-space: nowrap; }',
    '.ver { font-size: 10px; color: #7d8b9c; font-weight: 400; }',
    '.toolbar { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 10px; background: #131a22; border-bottom: 1px solid #2a333f; }',
    '.tabs { display: flex; gap: 2px; padding: 6px 8px 0; background: #131a22; border-bottom: 1px solid #2a333f; }',
    '.tabs.hide { display: none; }',
    '.tab { flex: 1; padding: 5px 2px 6px; border: 1px solid transparent; border-bottom: none; border-radius: 6px 6px 0 0;',
    '  background: transparent; color: #8b99a9; font-size: 11px; font-family: inherit; cursor: pointer; white-space: nowrap; }',
    '.tab:hover { color: #dbe6f2; background: #1a222c; }',
    '.tab.on { background: #11161d; color: #6cb6ff; border-color: #2a333f; font-weight: 600; }',
    '.pane { display: none; }',
    '.pane.on { display: block; }',
    '.btn { display: inline-flex; align-items: center; gap: 4px; padding: 4px 9px; border-radius: 6px; cursor: pointer;',
    '  background: #1e2731; color: #c9d6e4; border: 1px solid #2f3a47; font-size: 11px; font-family: inherit; }',
    '.btn:hover { background: #26313d; color: #fff; }',
    '.btn.primary { background: #1f6feb; border-color: #2f7ef0; color: #fff; }',
    '.btn.primary:hover { background: #2a7bf5; }',
    '.btn.on { background: #17452b; border-color: #2ea043; color: #7ee787; }',
    '.btn.danger { color: #ff9a94; }',
    '.icon { width: 22px; height: 22px; line-height: 1; border-radius: 6px; border: 1px solid #2f3a47; background: #1e2731; color: #a8b6c6; cursor: pointer; font-size: 14px; }',
    '.icon:hover { background: #2d3846; color: #fff; }',
    '.icon.wide { width: auto; min-width: 40px; padding: 0 8px; font-size: 12px; }',
    '.body { overflow-y: auto; overflow-x: hidden; padding: 8px; flex: 1; }',
    '.body::-webkit-scrollbar { width: 8px; }',
    '.body::-webkit-scrollbar-thumb { background: #313c49; border-radius: 4px; }',
    '.foot { padding: 5px 10px; font-size: 10px; color: #6f7d8c; background: #131a22; border-top: 1px solid #2a333f; }',
    '.sec { border: 1px solid #232c37; border-radius: 8px; margin-bottom: 8px; background: #151b23; overflow: hidden; }',
    '.sec-h { display: flex; align-items: center; gap: 6px; padding: 6px 9px; cursor: pointer; user-select: none;',
    '  background: #1a222c; font-weight: 600; color: #b9c7d6; font-size: 11.5px; letter-spacing: .3px; }',
    '.sec-h:hover { background: #1f2833; }',
    '.sec-h .arrow { color: #6f7d8c; font-size: 9px; transition: transform .15s; }',
    '.sec.open .sec-h .arrow { transform: rotate(90deg); }',
    '.sec-h .extra { margin-left: auto; font-weight: 400; color: #6f7d8c; font-size: 10px; }',
    '.sec-b { display: none; padding: 8px 9px; }',
    '.sec.open .sec-b { display: block; }',
    '.kv { display: grid; grid-template-columns: 62px 1fr; gap: 2px 8px; }',
    '.kv .k { color: #7d8b9c; }',
    '.kv .v { color: #dce7f2; word-break: break-all; }',
    '.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }',
    '.pill { display: inline-block; padding: 0 5px; margin-right: 4px; border-radius: 4px; font-size: 10px; border: 1px solid transparent; }',
    '.pill.ok { background: #10321c; color: #57d364; border-color: #1c5c2c; }',
    '.pill.bad { background: #3b1517; color: #ff8b85; border-color: #6b2226; }',
    '.pill.warn { background: #362a10; color: #e3b341; border-color: #6b521c; }',
    '.pill.dim { background: #1d2530; color: #8b99a9; border-color: #2b3644; }',
    '.pill.info { background: #102a44; color: #6cb6ff; border-color: #1c466f; }',
    '.grade { display: inline-block; min-width: 30px; text-align: center; padding: 0 5px; border-radius: 4px; font-weight: 700; font-size: 10px; }',
    '.gA { background: #11391f; color: #56d364; }',
    '.gB { background: #102c47; color: #6cb6ff; }',
    '.gC { background: #3a2f0d; color: #e3b341; }',
    '.gD { background: #3d2411; color: #ffa657; }',
    '.gFAIL { background: #421417; color: #ff7b72; }',
    '.loc { border: 1px solid #232c37; border-radius: 6px; padding: 6px; margin-bottom: 6px; background: #121820; }',
    '.loc-top { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }',
    '.loc-kind { color: #7d8b9c; font-size: 10.5px; }',
    '.loc-top .grade { margin-left: auto; }',
    '.loc-expr { display: block; background: #0c1116; border: 1px solid #1e2731; border-radius: 4px; padding: 5px 6px;',
    '  color: #a5d6ff; word-break: break-all; white-space: pre-wrap; max-height: 90px; overflow: auto; }',
    '.loc-meta { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-top: 4px; }',
    '.mini { margin-left: auto; padding: 1px 6px; border-radius: 4px; border: 1px solid #2f3a47; background: #1e2731;',
    '  color: #a8b6c6; cursor: pointer; font-size: 10px; font-family: inherit; }',
    '.mini:hover { background: #2d3846; color: #fff; }',
    '.fwt { font-size: 10.5px; color: #8b99a9; margin: 6px 0 4px; letter-spacing: .4px; text-transform: uppercase; }',
    '.tree, .tree ul { list-style: none; margin: 0; padding-left: 10px; border-left: 1px dashed #2a333f; }',
    '.tree { padding-left: 0; border-left: none; }',
    '.tree li { padding: 1px 0; }',
    '.noderow { display: flex; align-items: center; gap: 3px; flex-wrap: wrap; }',
    '.tag { color: #ffa657; }',
    '.eid { color: #79c0ff; }',
    '.ecls { color: #a5d6ff; }',
    '.etxt { color: #8b99a9; }',
    '.dim { color: #6f7d8c; }',
    '.row { display: flex; align-items: center; gap: 6px; padding: 3px 0; border-bottom: 1px solid #1c242e; }',
    '.row:last-child { border-bottom: none; }',
    '.row .name { color: #79c0ff; flex: 0 0 108px; word-break: break-all; }',
    '.row .val { color: #c9d6e4; flex: 1; word-break: break-all; }',
    '.row .cat { color: #6f7d8c; font-size: 9.5px; }',
    '.search { width: 100%; box-sizing: border-box; padding: 4px 7px; margin-bottom: 6px; border-radius: 5px;',
    '  background: #0c1116; border: 1px solid #2a333f; color: #dce7f2; font-size: 11px; font-family: inherit; outline: none; }',
    '.search:focus { border-color: #1f6feb; }',
    'pre.html { margin: 6px 0 0; padding: 6px; background: #0c1116; border: 1px solid #1e2731; border-radius: 5px;',
    '  color: #9fb2c6; max-height: 180px; overflow: auto; white-space: pre-wrap; word-break: break-all; }',
    '.btns { display: flex; flex-wrap: wrap; gap: 6px; }',
    '.empty { padding: 18px 10px; text-align: center; color: #6f7d8c; }',
    '.status { border-radius: 7px; padding: 6px 9px; margin-bottom: 8px; font-size: 11px; }',
    '.status.warn { background: #3a2c0d; border: 1px solid #6b521c; color: #e3b341; }',
    '.status.info { background: #10253c; border: 1px solid #1c466f; color: #79c0ff; }',
    '.status ul { margin: 3px 0 0; padding-left: 16px; }',
    '.hl { position: absolute; left: 0; top: 0; z-index: 1; pointer-events: none; display: none; }',
    '.hl-box { position: fixed; border: 2px solid #3d8bfd; background: rgba(61,139,253,.10); box-sizing: border-box;',
    '  box-shadow: 0 0 0 9999px rgba(6,9,13,.5); }',
    '.hl-box.nodim { box-shadow: none; }',
    '.hl-label { position: fixed; padding: 1px 6px; border-radius: 3px; background: #1f6feb; color: #fff;',
    '  font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; white-space: nowrap; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; }',
    '.hl-label.hidden-true { opacity: .75; }',
    '.pick-hint { position: fixed; left: 50%; top: 10px; transform: translateX(-50%); z-index: 2; pointer-events: none;',
    '  display: none; padding: 5px 12px; border-radius: 16px; background: rgba(12,17,22,.94); color: #cfe0f2;',
    '  border: 1px solid #2f7ef0; font-size: 11px; box-shadow: 0 6px 20px rgba(0,0,0,.5); white-space: nowrap; }',
    '.pick-hint.show { display: block; }',
    '.pick-hint b { color: #6cb6ff; }',
    '.toast { position: absolute; left: 50%; top: 14px; transform: translateX(-50%); padding: 6px 14px; border-radius: 6px; z-index: 4;',
    '  background: #1f6feb; color: #fff; font-size: 11.5px; opacity: 0; transition: opacity .2s; pointer-events: none; }',
    '.toast.show { opacity: 1; }',
    '.toast.err { background: #b62324; }',
    '.launcher { position: fixed; right: 14px; bottom: 14px; display: none; pointer-events: auto; cursor: pointer; z-index: 3;',
    '  padding: 6px 10px; border-radius: 16px; background: #1f6feb; color: #fff; border: none;',
    '  font-size: 11px; font-weight: 700; letter-spacing: .5px; box-shadow: 0 6px 20px rgba(31,111,235,.5); }',
    '.launcher.show { display: block; }',
    '.similar-item { display: flex; gap: 6px; align-items: baseline; padding: 3px 0; border-bottom: 1px solid #1c242e; }',
    '.similar-item.target { background: #14243a; }',
    '.similar-item .idx { color: #6f7d8c; flex: 0 0 26px; }',
    '.diff { font-size: 10px; color: #d29922; }',
    '.head { cursor: move; }',
    '.head .icon { cursor: pointer; }',
    '.coll-item { border: 1px solid #232c37; border-radius: 6px; padding: 6px; margin-bottom: 6px; background: #121820; }',
    '.coll-top { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }',
    '.coll-top b { flex: 1; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.marquee { position: fixed; display: none; z-index: 2; pointer-events: none;',
    '  border: 1.5px dashed #6cb6ff; background: rgba(61,139,253,.12); border-radius: 2px; }'
  ].join('\n');

  var PANEL_HTML = [
    '<div class="wrap">',
    '  <div class="panel" data-role="panel">',
    '    <div class="head">',
    '      <div class="brand"><span class="logo">AEI</span><span title="网页元素选择器（Agent Element Inspector）">网页元素选择器</span><span class="ver">v' + VERSION + '</span></div>',
    '      <button class="icon" data-act="collapse" title="折叠面板">▾</button>',
    '      <button class="icon" data-act="close" title="关闭工具（保留右下角入口）">×</button>',
    '    </div>',
    '    <div class="toolbar">',
    '      <button class="btn primary" data-act="pick">开始选择</button>',
    '      <button class="btn" data-act="stop">退出选择</button>',
    '      <button class="btn" data-act="reselect">重新选择</button>',
    '      <button class="btn" data-act="lock">锁定高亮</button>',
    '    </div>',
    '    <div class="tabs" data-role="tabs">',
    '      <button class="tab on" data-act="tab" data-tab="agent">Agent 输出</button>',
    '      <button class="tab" data-act="tab" data-tab="element">元素</button>',
    '      <button class="tab" data-act="tab" data-tab="locators">定位器</button>',
    '      <button class="tab" data-act="tab" data-tab="dom">结构</button>',
    '      <button class="tab" data-act="tab" data-tab="similar">相似</button>',
    '    </div>',
    '    <div class="body" data-role="body"></div>',
    '    <div class="foot">Alt+Shift+E 显示/隐藏 · Esc 退出选择 · ↑ 父级 · ↓ 子级 · ←→ 兄弟<br>Shift+单击多选 · 按住拖拽框选 · Ctrl+C 复制提示词 · Ctrl+Z 撤销<br>跨域 iframe 与封闭 Shadow DOM 受浏览器安全限制，无法直接检查</div>',
    '  </div>',
    '  <button class="launcher" data-act="open">AEI</button>',
    '  <div class="pick-hint" data-role="hint"><b>选择模式</b> · 单击锁定 · Shift+单击多选 · 拖拽框选 · Alt 穿透/取最内层 · ↑↓←→ 层级 · Esc 退出</div>',
    '  <div class="hl" data-role="hl"><div class="hl-box" data-role="hlbox"></div><div class="hl-label" data-role="hllabel"></div></div>',
    '  <div class="marquee" data-role="marquee"></div>',
    '  <div class="toast" data-role="toast"></div>',
    '</div>'
  ].join('\n');

  function ensureUI() {
    if (host) return;
    host = document.createElement('div');
    host.setAttribute('data-aei-host', '1');
    host.style.cssText = 'position:fixed;inset:0;z-index:' + Z_BASE + ';pointer-events:none;';
    document.documentElement.appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = CSS_TEXT;
    shadow.appendChild(style);
    var holder = document.createElement('div');
    holder.innerHTML = PANEL_HTML;
    while (holder.firstChild) shadow.appendChild(holder.firstChild);

    ui.panel = shadow.querySelector('[data-role="panel"]');
    ui.body = shadow.querySelector('[data-role="body"]');
    ui.hl = shadow.querySelector('[data-role="hl"]');
    ui.hlbox = shadow.querySelector('[data-role="hlbox"]');
    ui.hllabel = shadow.querySelector('[data-role="hllabel"]');
    ui.toast = shadow.querySelector('[data-role="toast"]');
    ui.launcher = shadow.querySelector('.launcher');
    ui.tabs = shadow.querySelector('[data-role="tabs"]');
    ui.hint = shadow.querySelector('[data-role="hint"]');
    ui.marquee = shadow.querySelector('[data-role="marquee"]');

    shadow.addEventListener('click', onUiClick, true);
    ui.body.addEventListener('input', onUiInput, true);
    ui.body.addEventListener('scroll', function () { /* 面板内滚动不处理 */ }, true);
    bindPanelDrag();
    applyPanelPos();
  }

  /* ---------- 面板位置与偏好持久化 ---------- */

  var SETTINGS_KEY = 'aei-settings-v1';

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        pos: state.panelPos,
        collapsed: state.collapsed,
        tab: state.tab
      }));
    } catch (e) { /* 隐私模式或存储被禁用 */ }
  }

  function loadSettings() {
    try {
      var s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
      if (!s) return;
      if (s.pos && typeof s.pos.left === 'number' && typeof s.pos.top === 'number') state.panelPos = s.pos;
      if (typeof s.collapsed === 'boolean') state.collapsed = s.collapsed;
      if (s.tab) state.tab = s.tab;
    } catch (e) { /* 忽略损坏的配置 */ }
  }

  function applyPanelPos() {
    if (!ui.panel || !state.panelPos) return;
    ui.panel.style.left = state.panelPos.left + 'px';
    ui.panel.style.top = state.panelPos.top + 'px';
    ui.panel.style.right = 'auto';
  }

  function bindPanelDrag() {
    var head = shadow.querySelector('.head');
    if (!head) return;
    var drag = null;
    head.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      if (e.target.closest && e.target.closest('button')) return;
      var r = ui.panel.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!drag) return;
      var x = Math.max(0, Math.min(window.innerWidth - 80, e.clientX - drag.dx));
      var y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - drag.dy));
      ui.panel.style.left = x + 'px';
      ui.panel.style.top = y + 'px';
      ui.panel.style.right = 'auto';
      state.panelPos = { left: x, top: y };
    });
    window.addEventListener('mouseup', function () {
      if (!drag) return;
      drag = null;
      saveSettings();
    });
  }

  /* ---------- 区域截图复制 ---------- */

  function grabFrame(stream) {
    var track = stream.getVideoTracks()[0];
    if (window.ImageCapture && track) {
      try { return new ImageCapture(track).grabFrame(); } catch (e) { /* 回退到 video */ }
    }
    return new Promise(function (resolve, reject) {
      var v = document.createElement('video');
      v.srcObject = stream;
      v.muted = true;
      v.play().then(function () {
        setTimeout(function () { resolve(v); }, 200);
      }).catch(reject);
    });
  }

  function copyScreenshot() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia ||
      !window.ClipboardItem || !navigator.clipboard || !navigator.clipboard.write) {
      toast('当前浏览器不支持区域截图复制（需 Chromium 内核与安全上下文）', true);
      return;
    }
    var targets = state.collection.length
      ? state.collection.map(function (it) { return it.el; }).filter(Boolean)
      : (state.current ? [state.current] : []);
    if (!targets.length) { toast('请先选择元素', true); return; }
    navigator.mediaDevices.getDisplayMedia({ preferCurrentTab: true, video: { frameRate: 1 } }).then(function (stream) {
      var saved = {
        panel: ui.panel.style.display,
        hl: ui.hl.style.display,
        hint: ui.hint.style.display,
        launcher: ui.launcher.style.display
      };
      ui.panel.style.display = 'none';
      ui.hl.style.display = 'none';
      ui.hint.style.display = 'none';
      ui.launcher.style.display = 'none';
      var restore = function () {
        ui.panel.style.display = saved.panel;
        ui.hl.style.display = saved.hl;
        ui.hint.style.display = saved.hint;
        ui.launcher.style.display = saved.launcher;
        stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* noop */ } });
      };
      return new Promise(function (resolve) { setTimeout(function () { resolve(grabFrame(stream)); }, 160); })
        .then(function (frame) {
          var sw = frame.width || frame.videoWidth;
          var sh = frame.height || frame.videoHeight;
          var dpr = window.devicePixelRatio || 1;
          var minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
          targets.forEach(function (el) {
            if (!el.isConnected) return;
            var r = el.getBoundingClientRect();
            minX = Math.min(minX, r.left * dpr);
            minY = Math.min(minY, r.top * dpr);
            maxX = Math.max(maxX, r.right * dpr);
            maxY = Math.max(maxY, r.bottom * dpr);
          });
          if (!isFinite(minX)) throw new Error('元素已不在文档中');
          var pad = 8 * dpr;
          minX = Math.max(0, Math.floor(minX - pad));
          minY = Math.max(0, Math.floor(minY - pad));
          maxX = Math.min(sw, Math.ceil(maxX + pad));
          maxY = Math.min(sh, Math.ceil(maxY + pad));
          var w = maxX - minX, h = maxY - minY;
          if (w <= 0 || h <= 0) throw new Error('截图区域为空（请确保元素在视口内）');
          var canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          canvas.getContext('2d').drawImage(frame, minX, minY, w, h, 0, 0, w, h);
          return new Promise(function (resolve) { canvas.toBlob(resolve, 'image/png'); });
        })
        .then(function (blob) {
          if (!blob) throw new Error('无法生成图片');
          return navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        })
        .then(function () { restore(); toast('已复制选中区域截图'); })
        .catch(function (err) { restore(); toast('截图失败：' + (err && err.message ? err.message : err), true); });
    }).catch(function () {
      toast('已取消截图授权', true);
    });
  }

  function toast(msg, isErr) {
    if (!ui.toast) return;
    ui.toast.textContent = msg;
    ui.toast.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { ui.toast.className = 'toast'; }, 1800);
  }

  function onUiInput(e) {
    var t = e.target;
    if (t && t.getAttribute && t.getAttribute('data-role') === 'coll-note') {
      var idx = parseInt(t.getAttribute('data-idx'), 10);
      if (state.collection[idx]) state.collection[idx].instruction = t.value || '';
      return;
    }
    if (t && t.getAttribute && t.getAttribute('data-role') === 'attr-search') {
      state.attrFilter = t.value || '';
      var host2 = ui.body.querySelector('[data-role="attr-list"]');
      if (host2) host2.innerHTML = attrListHtml();
    }
  }

  function onUiClick(e) {
    var t = e.target;
    var cp = t.closest('[data-copy]');
    if (cp) {
      e.preventDefault();
      e.stopPropagation();
      copyText(cp.getAttribute('data-copy'));
      return;
    }
    var cpr = t.closest('[data-copyref]');
    if (cpr) {
      e.preventDefault();
      e.stopPropagation();
      var ref = cpr.getAttribute('data-copyref');
      if (ref === 'html' && state.report) copyText(state.report._refs.html);
      return;
    }
    var secH = t.closest('.sec-h');
    if (secH) {
      var sec = secH.parentElement;
      var key = sec.getAttribute('data-sec');
      sec.classList.toggle('open');
      state.openSections[key] = sec.classList.contains('open');
      return;
    }
    var act = t.closest('[data-act]');
    if (!act) return;
    e.preventDefault();
    e.stopPropagation();
    handleAction(act.getAttribute('data-act'), act);
  }

  function handleAction(action, btn) {
    switch (action) {
      case 'pick': startPicking(); break;
      case 'stop': stopPicking(); break;
      case 'reselect':
        state.current = null;
        state.report = null;
        state.stale = false;
        state.staleNote = '';
        hideHighlight();
        startPicking();
        render();
        break;
      case 'lock':
        state.locked = !state.locked;
        btn.classList.toggle('on', state.locked);
        btn.textContent = state.locked ? '锁定中' : '锁定高亮';
        if (!state.locked) hideHighlight();
        else if (state.current) showHighlight(state.current);
        toast(state.locked ? '高亮已锁定' : '已取消锁定');
        break;
      case 'collapse':
        state.collapsed = !state.collapsed;
        ui.panel.classList.toggle('collapsed', state.collapsed);
        syncToolbar();
        saveSettings();
        break;
      case 'tab':
        state.tab = btn.getAttribute('data-tab') || 'agent';
        applyTab();
        saveSettings();
        break;
      case 'close':
        state.panelOpen = false;
        ui.panel.classList.add('hidden');
        ui.launcher.classList.add('show');
        stopPicking();
        break;
      case 'open':
        state.panelOpen = true;
        ui.panel.classList.remove('hidden');
        ui.launcher.classList.remove('show');
        break;
      case 'collect':
        if (state.report && state.current) {
          var exists = state.collection.some(function (it) { return it.el === state.current; });
          if (exists) {
            toast('该元素已在采集列表中');
          } else {
            state.collection.push({ el: state.current, report: state.report, instruction: '' });
            toast('已加入采集列表（' + state.collection.length + ' 个元素）');
            render();
          }
        }
        break;
      case 'export-collection':
        if (!state.collection.length) { toast('采集列表为空', true); break; }
        downloadJson(state.collection.map(function (it) {
          var rep = ensureItemReport(it);
          if (!rep) return null;
          var o = toAgentJson(rep);
          if (it.instruction) o.instruction = it.instruction;
          return o;
        }).filter(Boolean), 'aei-collection-' + Date.now() + '.json');
        break;
      case 'copy-prompt':
        if (state.report) {
          var cur = state.collection.filter(function (it) { return it.el === state.current; })[0];
          copyText(toPromptText(state.report, cur ? cur.instruction : ''));
        }
        break;
      case 'copy-collection-prompt':
        if (!state.collection.length) { toast('采集列表为空', true); break; }
        copyText(toPromptCollection());
        break;
      case 'copy-screenshot':
        copyScreenshot();
        break;
      case 'coll-focus': {
        var ci = parseInt(btn.getAttribute('data-idx'), 10);
        var item = state.collection[ci];
        if (item && item.el && item.el.isConnected) selectElement(item.el, true);
        else toast('该元素已不在文档中', true);
        break;
      }
      case 'coll-remove': {
        var ri = parseInt(btn.getAttribute('data-idx'), 10);
        state.collection.splice(ri, 1);
        render();
        break;
      }
      case 'copy-full':
        if (state.report) copyText(JSON.stringify(toAgentJson(state.report), null, 2));
        break;
      case 'copy-compact':
        if (state.report) copyText(JSON.stringify(toCompactJson(state.report), null, 2));
        break;
      case 'copy-text':
        if (state.report) copyText(toPlainText(state.report));
        break;
      case 'copy-locators':
        if (state.report) copyText(toLocatorText(state.report));
        break;
      case 'copy-html':
        if (state.report) copyText(state.report._refs.html);
        break;
      case 'download-json':
        if (state.report) downloadJson(toAgentJson(state.report), 'aei-element-' + Date.now() + '.json');
        break;
      case 'pick-node': {
        var kind = btn.getAttribute('data-kind');
        var rawIdx = btn.getAttribute('data-idx');
        var idx = /^\d+$/.test(rawIdx) ? parseInt(rawIdx, 10) : rawIdx;
        var pool = kind === 'parent' ? state.parentMap : kind === 'sibling' ? state.siblingMap :
          kind === 'similar' ? state.similarMap : state.nodeMap;
        var target = null;
        if (Array.isArray(pool)) target = pool[idx];
        else if (pool && pool[idx] !== undefined) target = pool[idx];
        if (target && target.nodeType === 1) selectElement(target, true);
        break;
      }
      default: break;
    }
  }

  function downloadJson(data, filename) {
    try {
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.documentElement.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
      toast('已导出 ' + filename);
    } catch (e) {
      toast('导出失败：' + e.message, true);
    }
  }

  /* ---------- 渲染 ---------- */

  function cls(grade) { return 'grade g' + grade; }

  function render() {
    if (!ui.body) return;
    ui.body.innerHTML = renderAll();
    applyTab();
    syncToolbar();
  }

  function applyTab() {
    if (!shadow) return;
    if (ui.tabs) ui.tabs.classList.toggle('hide', !state.report);
    var tabs = shadow.querySelectorAll('[data-act="tab"]');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('on', tabs[i].getAttribute('data-tab') === state.tab);
    }
    if (!ui.body) return;
    var panes = ui.body.querySelectorAll('[data-pane]');
    for (var j = 0; j < panes.length; j++) {
      panes[j].classList.toggle('on', panes[j].getAttribute('data-pane') === state.tab);
    }
  }

  function syncToolbar() {
    if (!shadow) return;
    var pickBtn = shadow.querySelector('[data-act="pick"]');
    if (pickBtn) {
      pickBtn.textContent = state.picking ? '选择中…' : '开始选择';
      pickBtn.classList.toggle('on', state.picking);
    }
    var lockBtn = shadow.querySelector('[data-act="lock"]');
    if (lockBtn) {
      lockBtn.classList.toggle('on', state.locked);
      lockBtn.textContent = state.locked ? '锁定中' : '锁定高亮';
    }
    var colBtn = shadow.querySelector('[data-act="collapse"]');
    if (colBtn) {
      colBtn.textContent = state.collapsed ? '展开' : '▾';
      colBtn.title = state.collapsed ? '展开面板' : '折叠面板';
      colBtn.classList.toggle('wide', state.collapsed);
    }
    if (ui.hint) ui.hint.classList.toggle('show', state.picking);
  }

  function renderAll() {
    var r = state.report;
    var html = '';
    if (!r) {
      html += statusHtml();
      html += '<div class="empty">尚未选择元素<br><span class="dim">点击「开始选择」后把鼠标移到目标元素上，单击即可锁定</span><br>' +
        '<span class="dim">跨域 iframe 与封闭 Shadow DOM 无法访问，工具不会伪造其内部结构</span></div>';
      return html;
    }
    html += '<div class="pane" data-pane="agent">' + agentHtml(r) + statusHtml() + crumbHtml(r) + '</div>';
    html += '<div class="pane" data-pane="element">' + summaryHtml(r) + attrsHtml(r) + '</div>';
    html += '<div class="pane" data-pane="locators">' + locatorsHtml(r) + '</div>';
    html += '<div class="pane" data-pane="dom">' + domHtml(r) + '</div>';
    html += '<div class="pane" data-pane="similar">' + similarHtml(r) + '</div>';
    return html;
  }

  function crumbHtml(r) {
    var e = r.element;
    var desc = e.tagName + (e.id ? '#' + e.id : '') + (e.classes.length ? '.' + e.classes.slice(0, 2).join('.') : '');
    var good = r.locators.filter(function (l) { return l.targetMatch && l.unique; }).length;
    return '<div class="status info">当前元素 <b class="mono">' + escHtml(desc) + '</b> · 综合评级 ' +
      escHtml(r.overallGrade) + ' · 唯一命中目标的定位器 ' + good + ' 个</div>';
  }

  function statusHtml() {
    var out = '';
    if (state.stale) {
      out += '<div class="status warn"><b>元素已失效</b><br>' + escHtml(state.staleNote) +
        '<br>已保留原始采集快照，请重新选择元素；不会自动操作替代节点。';
      if (state.staleInfo && state.staleInfo.length) {
        out += '<br><b>旧定位器复核</b>（找到的不一定是原节点）：<ul>' +
          state.staleInfo.map(function (x) {
            return '<li class="mono">' + escHtml(x.framework.toUpperCase() + ' ' + x.expr) +
              ' → 当前匹配 ' + x.count + ' 个</li>';
          }).join('') + '</ul>';
      }
      out += '</div>';
    }
    var r = state.report;
    if (r && r.warnings.length) {
      out += '<div class="status info"><b>风险提示</b><ul>' +
        r.warnings.map(function (w) { return '<li>' + escHtml(w) + '</li>'; }).join('') + '</ul></div>';
    }
    return out;
  }

  function secHead(key, title, extra) {
    var open = state.openSections[key] ? ' open' : '';
    return '<div class="sec-h"><span class="arrow">▶</span><span>' + title + '</span>' +
      (extra ? '<span class="extra">' + extra + '</span>' : '') + '</div>';
  }

  function summaryHtml(r) {
    var e = r.element;
    var text = truncate(normText(e.text), 80);
    var statePills = '';
    statePills += r.state.visible ? '<span class="pill ok">可见</span>' : '<span class="pill bad">不可见</span>';
    statePills += r.state.inViewport ? '<span class="pill ok">在视口</span>' : '<span class="pill warn">视口外</span>';
    statePills += r.state.covered ? '<span class="pill bad">中心被遮挡</span>' : '<span class="pill ok">未被遮挡</span>';
    statePills += r.state.clickable ? '<span class="pill ok">可点击</span>' : '<span class="pill dim">不可点击</span>';
    if (r.state.editable) statePills += '<span class="pill info">可输入</span>';
    if (r.state.focusable) statePills += '<span class="pill info">可聚焦</span>';
    if (r.state.disabled) statePills += '<span class="pill bad">disabled</span>';

    var desc = e.tagName + (e.id ? '#' + e.id : '') + (e.classes.length ? '.' + e.classes.slice(0, 3).join('.') : '');
    return '<section class="sec' + (state.openSections.summary ? ' open' : '') + '" data-sec="summary">' +
      secHead('summary', '元素摘要', '综合评级 ' + r.overallGrade) +
      '<div class="sec-b">' +
      '<div class="kv">' +
      '<span class="k">标签</span><span class="v mono">' + escHtml(desc) + '</span>' +
      '<span class="k">ID</span><span class="v mono">' + escHtml(e.id || '—') + '</span>' +
      '<span class="k">Class</span><span class="v mono">' + escHtml(e.classes.join(' ') || '—') + '</span>' +
      '<span class="k">role</span><span class="v mono">' + escHtml(e.role || '—') + ' <span class="dim">(' + escHtml(e.roleSource) + ')</span></span>' +
      '<span class="k">可访问名</span><span class="v">' + escHtml(e.accessibleName || '—') + '</span>' +
      '<span class="k">文本</span><span class="v">' + escHtml(text || '—') + '</span>' +
      '<span class="k">尺寸</span><span class="v mono">' + Math.round(r.box.viewportRect.width) + ' × ' + Math.round(r.box.viewportRect.height) +
      ' <span class="dim">页面 (' + Math.round(r.box.pageRect.x) + ', ' + Math.round(r.box.pageRect.y) + ')</span></span>' +
      '</div>' +
      '<div style="margin-top:6px">' + statePills + '</div>' +
      '</div></section>';
  }

  function locatorsHtml(r) {
    var groups = [
      { key: 'css', name: 'CSS Selector' },
      { key: 'xpath', name: 'XPath' },
      { key: 'playwright', name: 'Playwright' },
      { key: 'selenium', name: 'Selenium' }
    ];
    var inner = '';
    groups.forEach(function (g) {
      var rows = r.locators.filter(function (l) { return l.framework === g.key; });
      if (!rows.length) return;
      inner += '<div class="fwt">' + g.name + '</div>';
      rows.forEach(function (l) {
        var chips = '';
        chips += '<span class="pill ' + (l.count > 0 ? 'dim' : 'bad') + '">匹配 ' + l.count + '</span>';
        chips += l.unique ? '<span class="pill ok">唯一</span>' : '<span class="pill warn">非唯一</span>';
        chips += l.targetMatch ? '<span class="pill ok">命中目标</span>' : '<span class="pill bad">目标不一致</span>';
        chips += l.visible ? '<span class="pill dim">首个可见</span>' : '<span class="pill warn">首个不可见</span>';
        if (l.method === 'emulated') chips += '<span class="pill info">模拟校验</span>';
        inner += '<div class="loc">' +
          '<div class="loc-top"><span class="loc-kind">' + escHtml(l.label) + '</span>' +
          '<span class="' + cls(l.grade) + '">' + l.grade + '</span></div>' +
          '<code class="loc-expr mono">' + escHtml(l.expr) + '</code>' +
          '<div class="loc-meta">' + chips +
          '<button class="mini" data-copy="' + escHtml(l.expr) + '">复制</button></div>' +
          (l.note ? '<div class="dim" style="margin-top:3px">' + escHtml(l.note) + '</div>' : '') +
          '</div>';
      });
    });
    return '<section class="sec' + (state.openSections.locators ? ' open' : '') + '" data-sec="locators">' +
      secHead('locators', '定位器', r.locators.length + ' 条 · 已验证 ' +
        r.locators.filter(function (l) { return l.verified && l.targetMatch; }).length) +
      '<div class="sec-b">' + inner + '</div></section>';
  }

  function attrsHtml(r) {
    var all = r.element.attributes;
    return '<section class="sec' + (state.openSections.attrs ? ' open' : '') + '" data-sec="attrs">' +
      secHead('attrs', '属性', all.length + ' 项') +
      '<div class="sec-b">' +
      '<input class="search" data-role="attr-search" placeholder="搜索属性名或值…" value="' + escHtml(state.attrFilter) + '">' +
      '<div data-role="attr-list">' + attrListHtml() + '</div>' +
      '<div class="btns" style="margin-top:6px">' +
      '<button class="mini" data-copy="' + escHtml(JSON.stringify(attrObject(all), null, 2)) + '">复制全部属性</button>' +
      '</div></div></section>';
  }

  function attrObject(list) {
    var o = {};
    list.forEach(function (a) { o[a.name] = a.value; });
    return o;
  }

  function attrListHtml() {
    var r = state.report;
    if (!r) return '';
    var f = state.attrFilter.toLowerCase();
    var list = r.element.attributes.filter(function (a) {
      if (!f) return true;
      return (a.name + ' ' + a.value).toLowerCase().indexOf(f) !== -1;
    });
    if (!list.length) return '<div class="dim">没有匹配的属性</div>';
    return list.map(function (a) {
      return '<div class="row"><span class="name mono">' + escHtml(a.name) + '</span>' +
        '<span class="val mono">' + escHtml(truncate(a.value, 300)) + '</span>' +
        '<span class="cat">' + escHtml(a.category) + '</span>' +
        '<button class="mini" data-copy="' + escHtml(a.value) + '">复制</button></div>';
    }).join('');
  }

  function domHtml(r) {
    var parentMap = [];
    var siblingMap = [];
    var nodeMap = {};

    var parents = r.dom.parents.map(function (p) {
      parentMap.push(p.el);
      return '<div class="row"><span class="name mono">' + p.level + ' 级</span>' +
        '<span class="val mono">' + escHtml(p.selector) + '</span>' +
        '<button class="mini" data-act="pick-node" data-kind="parent" data-idx="' + (parentMap.length - 1) + '">选中</button></div>';
    }).join('');

    var sib = r.dom.siblings;
    sib.items.forEach(function (s) { siblingMap.push(s.el); });
    var sibRows = sib.items.map(function (s, i) {
      return '<div class="row"><span class="name mono">' + s.index + (s.isTarget ? ' ●' : '') + '</span>' +
        '<span class="val mono">' + escHtml(s.descriptor) + (s.text ? ' <span class="etxt">' + escHtml(s.text) + '</span>' : '') + '</span>' +
        '<button class="mini" data-act="pick-node" data-kind="sibling" data-idx="' + i + '">选中</button></div>';
    }).join('');

    var treeHtml = childrenTreeHtml(r.dom.children.items, nodeMap);

    var htmlPreview = truncate(r._refs.html, MAX_PREVIEW);

    state.parentMap = parentMap;
    state.siblingMap = siblingMap;
    state.nodeMap = nodeMap;

    return '<section class="sec' + (state.openSections.dom ? ' open' : '') + '" data-sec="dom">' +
      secHead('dom', 'DOM 结构', '深度 ' + r.dom.depth) +
      '<div class="sec-b">' +
      '<div class="fwt">DOM 路径</div>' +
      '<div class="loc-meta"><code class="loc-expr mono">' + escHtml(r.dom.path) + '</code>' +
      '<button class="mini" data-copy="' + escHtml(r.dom.path) + '">复制</button></div>' +
      '<div class="fwt">父级 / 祖先（' + r.dom.parents.length + '）</div>' + (parents || '<div class="dim">无父级</div>') +
      '<div class="fwt">兄弟元素（共 ' + sib.total + ' 个，当前第 ' + sib.index + ' 个；同标签 ' + sib.typeTotal + ' 个中第 ' + sib.typeIndex + '）</div>' +
      '<div class="dim">前一个：' + escHtml(sib.previous ? sib.previous.descriptor : '无') +
      ' · 后一个：' + escHtml(sib.next ? sib.next.descriptor : '无') + '</div>' +
      (sibRows || '') +
      '<div class="fwt">子级树（' + r.dom.children.count + ' 个直接子元素）</div>' + (treeHtml || '<div class="dim">无子元素</div>') +
      '<div class="fwt">OuterHTML' + (r.element.outerHTMLTruncated ? '（预览截断，复制为完整内容）' : '') + '</div>' +
      '<pre class="html mono">' + escHtml(htmlPreview) + '</pre>' +
      '<div class="btns" style="margin-top:6px"><button class="mini" data-copyref="html">复制完整 OuterHTML</button></div>' +
      '</div></section>';
  }

  function childrenTreeHtml(nodes, nodeMap) {
    if (!nodes || !nodes.length) return '';
    var out = '<ul class="tree">';
    nodes.forEach(function (n) {
      if (n.truncated) {
        out += '<li><span class="dim">' + escHtml(n.text) + '</span></li>';
        return;
      }
      var key = 'n' + (Object.keys(nodeMap).length + 1);
      nodeMap[key] = n.el;
      out += '<li><div class="noderow"><span class="tag">' + escHtml(n.tag) + '</span>' +
        (n.id ? '<span class="eid">#' + escHtml(n.id) + '</span>' : '') +
        (n.classes && n.classes.length ? '<span class="ecls">.' + escHtml(n.classes.slice(0, 2).join('.')) + '</span>' : '') +
        (n.text ? '<span class="etxt">' + escHtml(n.text) + '</span>' : '') +
        (!n.visible ? '<span class="pill bad">隐藏</span>' : '') +
        (n.interactive ? '<span class="pill info">交互</span>' : '') +
        '<button class="mini" data-act="pick-node" data-kind="child" data-idx="' + key + '">选中</button>' +
        '</div>' +
        childrenTreeHtml(n.children, nodeMap) + '</li>';
    });
    return out + '</ul>';
  }

  function similarHtml(r) {
    var s = r.similar;
    if (!s.compared) {
      return '<section class="sec' + (state.openSections.similar ? ' open' : '') + '" data-sec="similar">' +
        secHead('similar', '相似元素', '未发现同类') +
        '<div class="sec-b"><div class="dim">页面上未找到标签、role、文本与 class 均相同的其他元素。</div></div></section>';
    }
    var similarMap = [];
    var rows = s.items.map(function (it, i) {
      similarMap.push(it.el);
      var diffs = Object.keys(it.diff || {}).slice(0, 3).map(function (k) {
        return k + ': ' + (it.diff[k].target === null ? '（目标无）' : truncate(String(it.diff[k].target), 18)) +
          ' → ' + (it.diff[k].this === null ? '（无）' : truncate(String(it.diff[k].this), 18));
      });
      return '<div class="similar-item' + (it.isTarget ? ' target' : '') + '">' +
        '<span class="idx">#' + it.index + (it.isTarget ? '●' : '') + '</span>' +
        '<span class="mono" style="flex:1">' + escHtml(it.selector) +
        (it.text ? ' <span class="etxt">' + escHtml(it.text) + '</span>' : '') +
        (!it.visible ? ' <span class="pill bad">隐藏</span>' : '') +
        '<br><span class="dim">容器 ' + escHtml(it.container || '—') + '</span>' +
        (diffs.length ? '<br><span class="diff">' + escHtml(diffs.join(' · ')) + '</span>' : '') +
        '</span>' +
        '<button class="mini" data-act="pick-node" data-kind="similar" data-idx="' + i + '">对比</button>' +
        '</div>';
    }).join('');
    state.similarMap = similarMap;
    return '<section class="sec' + (state.openSections.similar ? ' open' : '') + '" data-sec="similar">' +
      secHead('similar', '相似元素', '共 ' + s.total + ' 个 · 当前第 ' + s.index + ' 个') +
      '<div class="sec-b">' + rows +
      '<div class="dim" style="margin-top:5px">差异字段仅列出前 6 项属性差异，用于判断该选哪一个。</div>' +
      '</div></section>';
  }

  function agentHtml(r) {
    var n = state.collection.length;
    return '<div class="btns">' +
      '<button class="btn primary" data-act="copy-prompt">复制 Agent 提示词</button>' +
      '<button class="btn" data-act="copy-full">复制完整信息包</button>' +
      '<button class="btn" data-act="copy-compact">复制精简 JSON</button>' +
      '<button class="btn" data-act="copy-html">复制 OuterHTML</button>' +
      '<button class="btn" data-act="copy-text">复制纯文本</button>' +
      '<button class="btn" data-act="copy-locators">复制定位器合集</button>' +
      '<button class="btn" data-act="download-json">导出 JSON 文件</button>' +
      '<button class="btn" data-act="collect">加入采集列表</button>' +
      '<button class="btn" data-act="copy-collection-prompt">复制采集提示词（' + n + '）</button>' +
      '<button class="btn" data-act="export-collection">导出采集列表（' + n + '）</button>' +
      '<button class="btn" data-act="copy-screenshot">复制区域截图</button>' +
      '</div>' +
      '<div class="dim" style="margin:6px 0 8px">提示词为面向 LLM 的极简格式（Page/selector/locator/inside/instruction），可直接粘贴给 Agent；完整信息包含全部定位器与真实验证结果。</div>' +
      collectionHtml();
  }

  function collectionHtml() {
    if (!state.collection.length) {
      return '<div class="dim" style="margin-top:8px">采集列表为空：选择元素后点「加入采集列表」，或用 Shift+单击 / 拖拽框选批量加入，再为每个元素填写指令。</div>';
    }
    var html = '<div class="fwt">采集列表（' + state.collection.length + '）</div>';
    state.collection.forEach(function (it, i) {
      var desc = it.el && it.el.isConnected ? describeShort(it.el) : '[元素已失效]';
      html += '<div class="coll-item" data-coll="' + i + '">' +
        '<div class="coll-top"><b class="mono">' + (i + 1) + '. ' + escHtml(desc) + '</b>' +
        '<button class="mini" data-act="coll-focus" data-idx="' + i + '">定位</button>' +
        '<button class="mini" data-act="coll-remove" data-idx="' + i + '">移除</button></div>' +
        '<input class="search" data-role="coll-note" data-idx="' + i + '" placeholder="为该元素填写指令（可选）" value="' + escHtml(it.instruction || '') + '">' +
        '</div>';
    });
    return html;
  }
  /* =========================================================
   * 五、元素选择器 / 动态监测 / 启动
   * ========================================================= */

  var picker = { hover: null };
  var PICK_TARGETS = [];
  var attachedDocs = [];

  function addPick(target, type, fn, capture) {
    target.addEventListener(type, fn, !!capture);
    PICK_TARGETS.push({ target: target, type: type, fn: fn, capture: !!capture });
  }

  var ACTION_SELECTOR = 'button,a[href],input,select,textarea,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="radio"],[role="switch"],summary';
  var dragBox = null;
  var suppressClick = false;

  function isInteractive(el) {
    try { return !!(el && el.matches && el.matches(ACTION_SELECTOR)); } catch (e) { return false; }
  }

  function hasDirectText(el) {
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3 && normText(n.textContent)) return true;
    }
    return false;
  }

  function resolveActionable(el) {
    if (!el || el.nodeType !== 1) return el;
    var act = null;
    try { act = el.closest ? el.closest(ACTION_SELECTOR) : null; } catch (e) { act = null; }
    if (act && act !== host && !isOwnUi(act)) return act;
    var cur = el, guard = 0;
    while (cur && cur !== document.body && cur !== document.documentElement && guard++ < 4) {
      if (/^(img|canvas|svg|video|iframe)$/i.test(cur.tagName)) return cur;
      if (hasDirectText(cur) && !cur.querySelector(ACTION_SELECTOR)) return cur;
      cur = parentOf(cur);
    }
    return el;
  }

  var TEXT_TAGS = /^(h[1-6]|p|li|td|th|dt|dd|label|summary|figcaption|blockquote)$/i;

  function isMeaningfulPick(el) {
    if (isInteractive(el)) return true;
    if (/^(img|canvas|svg|video|iframe)$/i.test(el.tagName)) return true;
    var role = el.getAttribute && el.getAttribute('role');
    if (role && !/^(presentation|none)$/.test(role)) return true;
    if (TEXT_TAGS.test(el.tagName) && hasDirectText(el) && !el.querySelector(ACTION_SELECTOR)) return true;
    return false;
  }

  function showMarquee(x1, y1, x2, y2) {
    if (!ui.marquee) return;
    ui.marquee.style.left = Math.min(x1, x2) + 'px';
    ui.marquee.style.top = Math.min(y1, y2) + 'px';
    ui.marquee.style.width = Math.abs(x2 - x1) + 'px';
    ui.marquee.style.height = Math.abs(y2 - y1) + 'px';
    ui.marquee.style.display = 'block';
  }

  function hideMarquee() {
    if (ui.marquee) ui.marquee.style.display = 'none';
  }

  function onHoverMove(e) {
    if (!state.picking) return;
    if (dragBox && e.buttons === 0) {
      // 鼠标在窗口外释放时收不到 mouseup，按无按键状态兜底取消框选
      dragBox = null;
      hideMarquee();
    }
    if (dragBox) {
      var dx = e.clientX - dragBox.x, dy = e.clientY - dragBox.y;
      if (!dragBox.on && Math.abs(dx) + Math.abs(dy) > 8) dragBox.on = true;
      if (dragBox.on) {
        showMarquee(dragBox.x, dragBox.y, e.clientX, e.clientY);
        if (ui.hl) ui.hl.style.display = 'none';
      }
      return;
    }
    var el = pickTarget(e);
    if (!el) return;
    if (el === picker.hover) {
      // 同一元素但高亮可能已被滚动/退出流程隐藏，需要重新显示
      if (ui.hl && ui.hl.style.display === 'none') showHighlight(el);
      return;
    }
    picker.hover = el;
    showHighlight(el);
  }

  function pickTarget(e) {
    var path = e.composedPath ? e.composedPath() : [e.target];
    var el = path && path[0];
    if (!el || el.nodeType !== 1) return null;
    if (isOwnUi(el)) return null;
    if (host && el === document.documentElement) return null;

    if (e.altKey) {
      // 按住 Alt：穿透到被覆盖的下一层元素
      var stack = [];
      try { stack = el.ownerDocument.elementsFromPoint(e.clientX, e.clientY); } catch (err) { stack = []; }
      for (var i = 0; i < stack.length; i++) {
        var s = stack[i];
        if (s === el) continue;
        if (isOwnUi(s)) continue;
        if (el.contains(s) || s.contains(el)) continue;
        return s;
      }
      return el;
    }
    return resolveActionable(el);
  }

  function onClickPick(e) {
    if (!state.picking) return;
    if (suppressClick) {
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      return;
    }
    var el = pickTarget(e);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    if (e.shiftKey) {
      addToCollection(el);
      state.tab = 'agent';
      applyTab();
      render();
      return;
    }
    selectElement(el, false);
  }

  function onMouseDownPick(e) {
    if (!state.picking) return;
    var path = e.composedPath ? e.composedPath() : [e.target];
    var el = path && path[0];
    if (!el || el.nodeType !== 1) return;
    if (isOwnUi(el) || !pickTarget(e)) return;
    if (e.button === 0) dragBox = { x: e.clientX, y: e.clientY, on: false };
    e.preventDefault();
  }

  function onMouseUpPick(e) {
    if (!dragBox) return;
    var d = dragBox;
    dragBox = null;
    hideMarquee();
    if (!d.on) return;
    suppressClick = true;
    setTimeout(function () { suppressClick = false; }, 0);
    var rect = {
      left: Math.min(d.x, e.clientX), top: Math.min(d.y, e.clientY),
      right: Math.max(d.x, e.clientX), bottom: Math.max(d.y, e.clientY)
    };
    if (rect.right - rect.left < 6 && rect.bottom - rect.top < 6) return;
    var all = collectDeepElements(document);
    var picked = [];
    for (var i = 0; i < all.length && picked.length < 12; i++) {
      var node = all[i];
      if (isOwnUi(node) || !isMeaningfulPick(node) || !isVisible(node)) continue;
      var r = node.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      if (r.right < rect.left || r.left > rect.right || r.bottom < rect.top || r.top > rect.bottom) continue;
      picked.push(node);
    }
    if (!picked.length) { toast('框选范围内没有可采集元素', true); return; }
    picked.forEach(function (node) { addToCollection(node, true); });
    state.tab = 'agent';
    applyTab();
    render();
    toast('已框选加入 ' + picked.length + ' 个元素');
  }

  function attachToDoc(doc) {
    if (!doc || attachedDocs.indexOf(doc) !== -1) return;
    attachedDocs.push(doc);
    addPick(doc, 'mousemove', rafThrottle(onHoverMove), true);
    addPick(doc, 'click', onClickPick, true);
    addPick(doc, 'mousedown', onMouseDownPick, true);
    addPick(doc, 'mouseup', onMouseUpPick, true);
    addPick(doc, 'scroll', rafThrottle(repositHighlight), true);
    var win = doc.defaultView;
    if (win && win !== window) {
      addPick(win, 'scroll', rafThrottle(repositHighlight), true);
      // 同源 iframe 内也需要响应 Esc / 方向键（事件不会冒泡到顶层 window）
      addPick(doc, 'keydown', onKeyDown, true);
    }
  }

  function attachPickers() {
    attachToDoc(document);
    var frames = [];
    try { frames = Array.prototype.slice.call(document.querySelectorAll('iframe, frame')); } catch (e) { frames = []; }
    frames.forEach(function (f) {
      var d = null;
      try { d = f.contentDocument; } catch (e) { d = null; }
      if (!d) return; // 跨域 iframe：无法进入
      attachToDoc(d);
    });
  }

  function detachPickers() {
    PICK_TARGETS.forEach(function (b) {
      try { b.target.removeEventListener(b.type, b.fn, b.capture); } catch (e) { /* noop */ }
    });
    PICK_TARGETS = [];
    attachedDocs = [];
  }

  function startPicking() {
    ensureUI();
    if (!state.panelOpen) {
      state.panelOpen = true;
      ui.panel.classList.remove('hidden');
      ui.launcher.classList.remove('show');
    }
    if (state.picking) return;
    state.picking = true;
    dragBox = null;
    hideMarquee();
    picker.hover = null; // 重新进入选择模式时清空悬停缓存，确保下一次悬停能立即高亮
    attachPickers();
    syncToolbar();
    toast('选择模式已开启：移动鼠标高亮，单击锁定；Esc 退出');
  }

  function stopPicking() {
    if (!state.picking) { syncToolbar(); return; }
    state.picking = false;
    detachPickers();
    picker.hover = null;
    dragBox = null;
    hideMarquee();
    if (state.locked && state.current && state.current.isConnected) showHighlight(state.current);
    else hideHighlight();
    syncToolbar();
  }

  /* ---------- 高亮层 ---------- */

  function showHighlight(el) {
    if (!ui.hl || !el || !el.isConnected) { hideHighlight(); return; }
    var r = absRect(el);
    if (!r.width && !r.height) { hideHighlight(); return; }
    ui.hlbox.style.left = Math.round(r.x) + 'px';
    ui.hlbox.style.top = Math.round(r.y) + 'px';
    ui.hlbox.style.width = Math.max(1, Math.round(r.width)) + 'px';
    ui.hlbox.style.height = Math.max(1, Math.round(r.height)) + 'px';

    var label = describeShort(el);
    var txt = normText(rawText(el));
    if (txt) label += '  「' + truncate(txt, 20) + '」';
    label += '  ' + Math.round(r.width) + '×' + Math.round(r.height);
    ui.hllabel.textContent = label;
    var ly = r.y - 21;
    if (ly < 2) ly = r.y + r.height + 2;
    ui.hllabel.style.left = Math.max(2, Math.min(r.x, window.innerWidth - 220)) + 'px';
    ui.hllabel.style.top = Math.max(0, ly) + 'px';
    ui.hl.style.display = 'block';
    // 选择模式下用超大 box-shadow 压暗整页，只留目标元素清晰（与 uBlock Origin 的取色器一致）
    ui.hlbox.className = 'hl-box' + (state.picking ? '' : ' nodim');
  }

  function hideHighlight() {
    if (ui.hl) ui.hl.style.display = 'none';
  }

  var repositHighlight = rafThrottle(function () {
    var el = state.picking ? picker.hover : (state.locked ? state.current : null);
    if (el && el.isConnected) showHighlight(el);
    else if (!el) hideHighlight();
  });

  /* ---------- 选中与导航 ---------- */

  var pendingNav = null;
  var navTimer = null;

  function selectElement(el, fromNav) {
    if (!el || el.nodeType !== 1) return;
    pushHistory();
    var report;
    try {
      resetScan();
      report = buildReport(el);
    } catch (err) {
      toast('采集失败：' + (err && err.message ? err.message : err), true);
      return;
    }
    state.report = report;
    state.current = el;
    state.currentRoot = getScope(el);
    observeCurrentRoot();
    state.stale = false;
    state.staleNote = '';
    state.staleInfo = null;
    picker.hover = el;
    showHighlight(el);
    render();
    if (!fromNav) {
      toast('已锁定 ' + describeShort(el) + '，评级 ' + report.overallGrade);
    }
  }

  function navigateTo(el) {
    if (!el || el.nodeType !== 1) { toast('该方向没有可切换的元素', true); return; }
    if (host && (el === host || host.contains(el))) return;
    picker.hover = el;
    showHighlight(el);
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* noop */ }
    if (state.report) {
      pendingNav = el;
      clearTimeout(navTimer);
      navTimer = setTimeout(function () {
        if (pendingNav) selectElement(pendingNav, true);
      }, 160);
    }
  }

  function parentOf(el) {
    return el.parentElement || (el.parentNode && el.parentNode.host) || null;
  }

  function onKeyDown(e) {
    var mod = e.metaKey || e.ctrlKey;
    var keyLower = String(e.key || '').toLowerCase();
    var active = document.activeElement;
    var inPanel = false;
    try { inPanel = !!(shadow && shadow.activeElement); } catch (err) { inPanel = false; }
    if (mod && !e.shiftKey && keyLower === 'c' && state.report && (inPanel || state.picking)) {
      e.preventDefault();
      var curItem = state.collection.filter(function (it) { return it.el === state.current; })[0];
      copyText(toPromptText(state.report, curItem ? curItem.instruction : ''));
      return;
    }
    if (mod && !e.shiftKey && keyLower === 'z' && (inPanel || state.picking)) {
      e.preventDefault();
      undo();
      return;
    }
    if (e.altKey && e.shiftKey && e.code === 'KeyE') {
      e.preventDefault();
      togglePanel();
      return;
    }
    if (e.altKey && e.shiftKey && e.code === 'KeyS') {
      e.preventDefault();
      startPicking();
      return;
    }
    if (e.key === 'Escape') {
      if (state.picking) {
        e.preventDefault();
        e.stopPropagation();
        stopPicking();
        toast('已退出选择模式');
      }
      return;
    }
    if (!state.picking) return;
    var base = picker.hover || state.current;
    var key = e.key;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].indexOf(key) === -1) return;
    e.preventDefault();
    e.stopPropagation();
    if (!base) return;
    var next = null;
    if (key === 'ArrowUp') next = parentOf(base);
    else if (key === 'ArrowDown') next = base.firstElementChild;
    else if (key === 'ArrowLeft') next = base.previousElementSibling;
    else if (key === 'ArrowRight') next = base.nextElementSibling;
    navigateTo(next);
  }

  function bindKeyboard() {
    window.addEventListener('keydown', onKeyDown, true);
  }

  function togglePanel() {
    ensureUI();
    state.panelOpen = !state.panelOpen;
    ui.panel.classList.toggle('hidden', !state.panelOpen);
    ui.launcher.classList.toggle('show', !state.panelOpen);
  }

  /* ---------- 动态监测 ---------- */

  function startMonitor() {
    if (state.monitor) return;
    var check = debounce(function () {
      observeCurrentRoot();
      if (!state.current) return;
      if (!state.current.isConnected) {
        if (!state.stale) {
          state.stale = true;
          state.staleNote = '元素已从文档中移除（可能被页面重新渲染、替换或卸载）';
          revalidate();
          hideHighlight();
          render();
        }
      } else if (state.stale) {
        state.stale = false;
        state.staleNote = '';
        state.staleInfo = null;
        render();
      }
    }, 300);
    state.monitor = new MutationObserver(check);
    try {
      state.monitor.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) { /* noop */ }
  }

  // Shadow DOM 内部的变更不会冒泡到 documentElement，需要单独观察当前元素所在的影子根
  function observeCurrentRoot() {
    if (!state.monitor) return;
    var root = state.currentRoot;
    var guard = 0;
    while (root && root.nodeType === 11 && guard++ < 20) {
      if (state.observedRoots.indexOf(root) === -1) {
        try { state.monitor.observe(root, { childList: true, subtree: true }); } catch (e) { /* noop */ }
        state.observedRoots.push(root);
      }
      root = root.host ? root.host.getRootNode() : null;
    }
  }

  function revalidate() {
    var r = state.report;
    if (!r) return;
    var root = state.currentRoot || document;
    var out = [];
    r.locators.forEach(function (l) {
      var count = null;
      try {
        if (l.framework === 'css') {
          var list = safeQuery(root, l.expr);
          count = list ? list.length : null;
        } else if (l.framework === 'xpath') {
          var ctx = (root.nodeType === 11) ? root : document;
          var res = document.evaluate(l.expr, ctx, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          count = res.snapshotLength;
        }
      } catch (e) { count = null; }
      if (count !== null) out.push({ framework: l.framework, expr: l.expr, count: count });
    });
    state.staleInfo = out;
  }

  /* ---------- 启动 ---------- */

  function init() {
    ensureUI();
    loadSettings();
    if (state.collapsed) ui.panel.classList.add('collapsed');
    bindKeyboard();
    startMonitor();
    render();
    applyTab();
    syncToolbar();
    applyPanelPos();
    window.addEventListener('resize', repositHighlight);
    window.addEventListener('scroll', repositHighlight, true);
    document.addEventListener('load', function (e) {
      var t = e.target;
      if (t && t.tagName && /^(IFRAME|FRAME)$/i.test(t.tagName) && state.picking) attachPickers();
    }, true);
  }

  // 调试 / 验收桥接：供测试脚本与 Agent 协作读取事实信息，不参与页面业务逻辑
  window.__AEI__ = {
    version: VERSION,
    start: function () { startPicking(); },
    stop: function () { stopPicking(); },
    select: function (el) { selectElement(el, true); return state.report; },
    report: function () { return state.report ? toAgentJson(state.report) : null; },
    compact: function () { return state.report ? toCompactJson(state.report) : null; },
    prompt: function (instruction) { return state.report ? toPromptText(state.report, instruction) : ''; },
    collectionPrompt: function () { return toPromptCollection(); },
    addCollection: function (el) { addToCollection(el); return state.collection.length; },
    setInstruction: function (i, text) { if (state.collection[i]) state.collection[i].instruction = text; },
    removeCollection: function (i) { state.collection.splice(i, 1); },
    clearCollection: function () { state.collection = []; render(); },
    undo: function () { undo(); },
    state: state
  };

  function boot() {
    if (document.documentElement) init();
    else setTimeout(boot, 50);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
