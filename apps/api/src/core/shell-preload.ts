/**
 * 帖子详情页的首屏数据预载脚本（由 SPA 壳注入，在 HTML 解析期执行）。
 *
 * 依据：帖子详情的 URL 规则唯一且不含语言维度（`/thread/:tid`、`/thread/:tid/p/:page`），
 * 前端 `apiGet` 的地址就是 `/api/threads/:tid?page=N`（见 ThreadPage 的 useQuery），
 * 这里逐字复刻即可被浏览器 preload 缓存复用，不产生第二次请求。
 *
 * 为什么必须运行时按 `location.pathname` 生成：壳 HTML 全站共用一条缓存副本
 * （键 `/__fi/spa-shell`，见 core/cache/edge.ts）。若把 `<link rel="preload">` 静态写进壳，
 * 只有首个写入缓存的路径能命中，其余深链会白下。
 *
 * 边界：tid 非法 / 非整数 / 前导零都按数字归一（与前端 idParam 的 Number 口径一致）；
 * 正则不匹配的路径（paylist、版块页、首页）不输出任何标签，零副作用。
 *
 * 导出供单测（生成的是浏览器脚本字符串，只能在执行后断言副作用）。
 */
export function threadPreloadScript(): string {
  return (
    `try{var m=/^\\/thread\\/(\\d+)(?:\\/p\\/(\\d+))?\\/?$/.exec(location.pathname);` +
    `if(m){var tid=+m[1];if(tid>0&&Number.isSafeInteger(tid)){` +
    `var pg=+(m[2]||1);if(!(pg>0))pg=1;` +
    `var l=document.createElement("link");l.rel="preload";l.as="fetch";` +
    `l.crossOrigin="use-credentials";l.href="/api/threads/"+tid+"?page="+pg;` +
    `document.head.appendChild(l)}}}catch(e){}`
  );
}

/**
 * 首页 / 版块页的列表数据预载。
 *
 * 与 `siteThreadsQuery`（首页、发现页共用）和 `ForumPage` 的 useQuery 逐字对齐：
 *   首页   `page` 来自路径 `/page/:n`，`digest`/`orderby` 来自查询串；
 *   版块页 `page`/`digest`/`orderby`/`tag` 全部来自查询串。
 *
 * 内容语言必须复刻 `useContentLangFilter`（store/contentLang.ts）：
 *   mode<=0 → 不过滤；localStorage 偏好 'all' → 不过滤；有偏好 → 用偏好；
 *   无偏好且 mode===2 → 跟界面语言（`document.documentElement.lang` 已是壳算好的 fiG）。
 * 这段与前端实现互为镜像，改动必须同步，否则预载 URL 对不上会白下一次。
 *
 * 只处理 `/`、`/page/:n`、`/forum/:fid`；其余路径不输出标签。
 */
export function listPreloadScript(): string {
  return (
    `try{` +
    `function fiCL(v){v=String(v||"").trim().toLowerCase();if(!v||v==="all")return "";` +
    `var L=["zh","en","ja","ko","ru","th","de","fr","es","other"];` +
    `if(L.indexOf(v)>=0)return v;var b=v.split("-")[0];return L.indexOf(b)>=0?b:""}` +
    `var mode=Number(window.__FI_CONTENT_LANG_MODE__)||0;var cl="";` +
    `if(mode>0){var cp=null;try{cp=localStorage.getItem("freeidx.contentLang")}catch(e){}` +
    `if(cp!=="all"){cl=fiCL(cp);if(!cl&&mode===2)cl=fiCL(typeof fiG!=="undefined"?fiG:document.documentElement.lang)}}` +
    `var u=new URLSearchParams(location.search);var href=null;` +
    `var m=/^\\/page\\/([^/]+)\\/?$/.exec(location.pathname);` +
    `if(location.pathname==="/"||m){` +
    `var pg=Math.floor(Number(m?m[1]:1));if(!Number.isFinite(pg)||!(pg>=1))pg=1;` +
    `href="/api/threads?page="+pg+(u.get("digest")==="1"?"&digest=1":"")+` +
    `"&orderby="+(u.get("orderby")==="lastpid"?"lastpid":"tid")+` +
    `(cl?"&lang="+encodeURIComponent(cl):"")` +
    `}else{var f=/^\\/forum\\/(\\d+)\\/?$/.exec(location.pathname);` +
    `if(f){var fid=+f[1];if(fid>0&&Number.isSafeInteger(fid)){` +
    `var pg=Math.floor(Number(u.get("page")));if(!Number.isFinite(pg)||!(pg>=1))pg=1;` +
    `var tag=(u.get("tag")||"").trim();` +
    `href="/api/forums/"+fid+"/threads?page="+pg+(u.get("digest")==="1"?"&digest=1":"")+` +
    `"&orderby="+(u.get("orderby")==="lastpid"?"lastpid":"tid")+` +
    `(tag?"&tag="+encodeURIComponent(tag):"")+(cl?"&lang="+encodeURIComponent(cl):"")}}}` +
    `if(href){var l=document.createElement("link");l.rel="preload";l.as="fetch";` +
    `l.crossOrigin="use-credentials";l.href=href;document.head.appendChild(l)}}catch(e){}`
  );
}
