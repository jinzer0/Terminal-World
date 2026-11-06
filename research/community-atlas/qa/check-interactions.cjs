'use strict';
// Logic checks only. This minimal DOM does not implement layout, browser focus or print rendering.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const base = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(base, 'app.js'), 'utf8');
class Node {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.dataset = {}; this.className = ''; this.attributes = {}; this.listeners = {}; this.hidden = false; this.open = false; this.value = ''; this.checked = false; }
  append(...nodes) { for (const node of nodes) { if (node.parent) node.parent.children = node.parent.children.filter(n => n !== node); node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children.forEach(n => { n.parent = null; }); this.children = []; this.append(...nodes); }
  get classList() { return {toggle: (name, value) => { const tokens = new Set(this.className.split(' ').filter(Boolean)); if (value) tokens.add(name); else tokens.delete(name); this.className = [...tokens].join(' '); }, add: name => this.classList.toggle(name, true), remove: name => this.classList.toggle(name, false)}; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  matches(selector) { if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1)); if (selector === 'details') return this.tagName === 'details'; if (selector === 'details[open]') return this.tagName === 'details' && this.open; const match = selector.match(/^\[data-([a-z-]+)\]$/); if (match) return match[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase()) in this.dataset; return false; }
  querySelectorAll(selector) { return this.children.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]); }
  closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector); }
}
const roots = new Map();
function $(id) { if (!roots.has(id)) roots.set(id, new Node()); return roots.get(id); }
const document = {createElement: tag => new Node(tag), querySelectorAll: selector => [...roots.values()].flatMap(node => node.querySelectorAll(selector))};
['community-grid','community-count','compare-tray','compare-count','compare-names','compare-reset','community-search','deep-only','source-list','source-count','source-filter','source-search','idea-grid','idea-count','idea-filter','idea-sort'].forEach($);
const communities = [
  {id:'a',name:'Alpha maker',groupId:'creative',depth:'deep',job:'작품 만들기'},
  {id:'b',name:'Beta reader',groupId:'creative',depth:'scan',job:'관객 반응'},
  {id:'c',name:'Gamma lab',groupId:'knowledge',depth:'deep',job:'기술 실험'},
  {id:'d',name:'Delta archive',groupId:'knowledge',depth:'scan',job:'자료 읽기'}
].map(c => ({...c, groupTitle:c.groupId, description:'fixture', status:'fixture', url:'https://example.com/'+c.id, sources:[{url:'https://example.com/source/'+c.id,title:'fixture',type:c.depth==='deep'?'official':'user',claim:c.job}]}));
const state = {category:'all',search:'',deep:false,selected:[],sourceType:'all',sourceSearch:'',ideaFilter:'all',ideaSort:'original'};
const notices = [];
const context = vm.createContext({document,$,communities,state,labels:{},types:{},URL,Set,toast:message=>notices.push(message)});
const names = ['element','link','raw','field','toggleSelection','updateSelection','renderCommunities','renderSources'];
for (const name of names) { const line = source.split('\n').find(line => line.trimStart().startsWith(`function ${name}(`)); assert(line, `missing actual function ${name}`); vm.runInContext(line,context); }
vm.runInContext('const citations=communities.flatMap(c=>c.sources.map(s=>({community:c.name,...s})));',context);
const ideaMarkup = fs.readFileSync(path.join(base,'analysis-directions.html'),'utf8');
for (const attrs of ideaMarkup.matchAll(/<details\s[^>]*data-idea-id="[^>]+>/g)) { const card=new Node('details'); for(const [key,value] of [...attrs[0].matchAll(/data-idea-([a-z]+)="([^"]+)"/g)].map(m=>[m[1],m[2]])) card.dataset['idea'+key[0].toUpperCase()+key.slice(1)]=value; card.open=attrs[0].includes(' open'); $('idea-grid').append(card); }
assert.equal($('idea-grid').children.length,9,'nine actual idea metadata records');
const ideaBlock=source.slice(source.indexOf("  const ideaGrid=$('idea-grid');"),source.indexOf('  let printSnapshot=null;'));
vm.runInContext(ideaBlock,context);
const printBlock=source.slice(source.indexOf('  let printSnapshot=null;'),source.indexOf("  addEventListener('beforeprint'"));
vm.runInContext(printBlock,context);
const run = code => vm.runInContext(code,context);
run('renderCommunities()'); assert.match($('community-count').textContent,/^4 \/ 4/);
state.category='creative';run('renderCommunities()');assert.match($('community-count').textContent,/^2 \/ 4/);
state.deep=true;run('renderCommunities()');assert.match($('community-count').textContent,/^1 \/ 4/);
state.category='all';state.deep=false;state.search='GAMMA';run('renderCommunities()');assert.match($('community-count').textContent,/^1 \/ 4/);
state.search='no match';run('renderCommunities()');assert.match($('community-count').textContent,/^0 \/ 4/);assert.equal($('community-grid').children[0].className,'empty-state');
state.search='';run('renderCommunities()');
for (const id of ['a','b','c','d']) run(`toggleSelection('${id}')`);
assert.deepEqual(state.selected,['a','b','c']);assert.equal(notices.length,1);assert.equal($('compare-tray').hidden,false);
run("toggleSelection('b')");assert.deepEqual(state.selected,['a','c']);
const resetStart=source.indexOf("$('compare-reset').addEventListener");const resetEnd=source.indexOf('});',resetStart)+3;assert(resetStart>0&&resetEnd>resetStart);run(source.slice(resetStart,resetEnd));$('compare-reset').listeners.click();assert.deepEqual(Array.from(state.selected),[]);assert.equal($('compare-tray').hidden,true);
for (const filter of ['keep','partial','full']) {state.ideaFilter=filter;run('renderIdeas()');assert.equal($('idea-grid').children.filter(n=>!n.hidden).length,3);}
state.ideaFilter='all';state.ideaSort='easy';run('renderIdeas()');assert.equal($('idea-grid').children[0].dataset.ideaId,'07');assert.equal($('idea-grid').children.at(-1).dataset.ideaId,'04');
state.ideaSort='hard';run('renderIdeas()');assert.equal($('idea-grid').children[0].dataset.ideaId,'04');
state.category='creative';state.search='alpha';state.deep=true;state.sourceType='official';state.sourceSearch='작품';state.ideaFilter='keep';state.ideaSort='hard';run('renderCommunities();renderSources();renderIdeas()');
const detail=$('community-grid').querySelectorAll('details')[0];detail.open=true;const saved=JSON.parse(JSON.stringify(state));const order=$('idea-grid').children.map(n=>n.dataset.ideaId);
run('preparePrint()');assert.equal(state.category,'all');assert.equal(state.search,'');assert.equal(state.deep,false);assert.equal($('community-grid').children.length,4);assert.equal($('source-list').children.length,4);assert.equal($('idea-grid').children.filter(n=>!n.hidden).length,9);assert(document.querySelectorAll('details').every(n=>n.open));
run('preparePrint();restorePrint()');assert.deepEqual(JSON.parse(JSON.stringify(state)),saved);assert.deepEqual($('idea-grid').children.map(n=>n.dataset.ideaId),order);assert.equal($('idea-grid').children.filter(n=>!n.hidden).length,3);assert.equal($('community-grid').querySelectorAll('details')[0].open,true);run('restorePrint()');
console.log('PASS: actual app.js functions — case search/category/deep filters; selection max3/remove/reset; nine-idea filter/sort; print all-content preparation and state/order/open restoration.');
console.log('LIMIT: minimal Node VM DOM fixture only; no browser execution, layout, CSS overflow, keyboard focus, native dialog or actual print/PDF verification.');
