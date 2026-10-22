/**
 * 访客设备类型识别（配合后台「设备访问三开关」device_phone_on / device_tablet_on / device_tv_on）：
 *  - TV：智能电视/电视盒子 UA 特征词（SMART-TV / AppleTV / Tizen / WebOS / CrKey / AFT* 等）；
 *  - 平板：iPad/Android(非 Mobile)/Kindle/Silk 等；iPhone 等带 Mobile 的移动 UA 归手机；
 *  - 兜底：无 UA 命中但触屏 + 短边 ≤ 480px 的小屏视作手机；
 *  - 台式机/笔记本恒为 desktop，不受开关约束。
 */
type DeviceKind = 'desktop' | 'phone' | 'tablet' | 'tv';

const TV_UA = /SMART-TV|SmartTV|SmartTv|AppleTV|GoogleTV|HbbTV|NETCAST|NetCast|CrKey|Tizen|Web0S|WebOS|BRAVIA|AFT[BMST]|AndroidTV|SHIELD|PhilipsTV|Viera|HUAWEITV|MiTV|Coocaa|Chromecast/i;

export function detectDevice(
  ua: string = navigator.userAgent,
  maxTouchPoints: number = navigator.maxTouchPoints ?? 0,
): DeviceKind {
  if (TV_UA.test(ua)) return 'tv';
  if (/iPad|Tablet|PlayBook|Silk|Kindle/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tablet';
  if (/Mobi|iPhone|iPod|Windows Phone|IEMobile|BlackBerry|Opera Mini/i.test(ua)) return 'phone';
  /* 触屏小屏兜底（部分安卓 WebView UA 不含 Mobi） */
  if (maxTouchPoints > 0 && typeof screen !== 'undefined' && Math.min(screen.width, screen.height) <= 480) return 'phone';
  return 'desktop';
}
