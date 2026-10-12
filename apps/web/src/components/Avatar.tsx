import { avatarUrl } from '../lib/api';

/** 五档圆形头像（§1.3：avatar-1..5 = 1.3/1.8/2.4/4.5/6 rem），无图降级用预设头像（/avatars/0..56.png 共 57 张，与后端白名单一致，按 uid 取模稳定分配） */
const LEVEL: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: '1.3rem',
  2: '1.8rem',
  3: '2.4rem',
  4: '4.5rem',
  5: '6rem',
};

/** 预设头像张数（后端白名单 /avatars/0..56.png） */
const PRESET_COUNT = 57;

export function Avatar(props: {
  uid: number;
  avatar: number;
  username: string;
  size?: 1 | 2 | 3 | 4 | 5;
  /** 固定像素尺寸，覆盖档位（后台锁屏头像 `.lockscreen-image>img` 是 70px，不属于 avatar-1..5 任一档） */
  dim?: string;
  /** 圆角：默认圆形；lg = 10px 方角（主题“关于盘主”卡）；soft = 按比例的圆角方形（帖子列表头像） */
  radius?: 'full' | 'lg' | 'soft';
  className?: string;
}) {
  const { uid, avatar, username, size = 3, dim, radius = 'full', className } = props;
  const round = radius === 'full' ? 'rounded-full' : radius === 'lg' ? 'rounded-[10px]' : 'rounded-[22%]';
  const boxSize = dim ?? LEVEL[size];
  const box = { width: boxSize, height: boxSize, fontSize: `calc(${boxSize} * .45)` };
  const url = avatarUrl(uid, avatar);
  /* 列表页一屏可有数十个头像：统一 lazy + async 解码，避免首屏下方头像与主内容抢带宽
     （视口内的 lazy 图片浏览器仍会立即加载，顶部栏头像不受影响）；宽高已由 style 给定，无布局抖动 */
  if (!url) {
    return <img src={`/avatars/${uid % PRESET_COUNT}.png`} alt={username} loading="lazy" decoding="async" className={`${round} shrink-0 bg-line object-cover ${className ?? ''}`} style={box} />;
  }
  return <img src={url} alt={username} loading="lazy" decoding="async" className={`${round} shrink-0 bg-line object-cover ${className ?? ''}`} style={box} />;
}
