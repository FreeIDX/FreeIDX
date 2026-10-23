/**
 * 显式投影列常量（§7 禁 SELECT *）。
 * 列表查询永不触碰 post.message/message_fmt；详情页按 pid 单独取。
 */
export const T = 'bbs_thread';
export const P = 'bbs_post';

/** 列表行 = 单表扫描零 JOIN（thread 已反规范化，§5.2）；ok 为 tt_check 审核位（列表过滤 + see_check 图标）；
 *  content_buy/content_buy_type 为 tt_credits 付费位（列表标题后购物车图标）；
 *  tags 为简蓝主题标签（逗号分隔，00013 迁移新增，idx_tag 轻量实现）；
 *  image_urls 为列表图片组（≤9 张逗号分隔，00014 迁移新增）；
 *  summary 为列表摘要纯文本（≤300 字，00017 迁移新增） */
export const THREAD_LIST_COLS =
  'tid,fid,top,digest,closed,uid,username,avatar,subject,posts,views,images,files,lastpid,lastuid,lastusername,create_date,last_date,ok,content_buy,content_buy_type,tags,image_urls,summary,lang';

/** thread_top JOIN thread 用显式前缀投影（禁运行期字符串改写） */
export const THREAD_LIST_COLS_T =
  't.tid,t.fid,t.top,t.digest,t.closed,t.uid,t.username,t.avatar,t.subject,t.posts,t.views,t.images,t.files,t.lastpid,t.lastuid,t.lastusername,t.create_date,t.last_date,t.ok,t.content_buy,t.content_buy_type,t.tags,t.image_urls,t.summary,t.lang';

/** 详情页 thread 行（不含正文） */
export const THREAD_DETAIL_COLS = THREAD_LIST_COLS + ',firstpid,mods,userip';

/** lang 为版块绑定内容语言（0024：空串 = 未绑定：顶级不限制 / 子版块继承父版块；'none' = 显式不限制（仅子版块）；其余 = 新主题强制该语言） */
export const FORUM_COLS =
  'fid,name,rank,threads,todayposts,todaythreads,brief,announcement,accesson,orderby,icon,moduids,seo_title,seo_keywords,icon_file,icon_time,thread_check,post_check,edit_check,parent_fid,lang';

/** 详情页回帖：取 fmt 展示 + message 原文（冻结契约 PostItem.message? "仅详情页返回"，供内联编辑初值）；ok 为审核位 */
export const POST_PAGE_COLS =
  'pid,tid,uid,isfirst,create_date,userip,images,files,doctype,quotepid,message,message_fmt,ok';

/** avatar_auto 为预设头像路径（'0'=未用预设；解析语义见 modules/shared.ts avatarAutoOf)；
 *  bgimg 为主页背景预设编号（'0'=默认 bg-0.png，0016 迁移新增） */
export const USER_PUBLIC_COLS =
  'uid,gid,username,avatar,threads,posts,credits,create_date,login_date,ok,v,avatar_auto,bgimg';

/** 后台用户列表投影：公开列 + email/create_ip（只给 /api/admin/users） */
export const USER_ADMIN_LIST_COLS = `${USER_PUBLIC_COLS}, email, create_ip`;

export const USER_SESSION_COLS = 'uid,gid,password,salt,token_version,avatar,username,email,ok';
