/**
 * 权限决策判定（共享工具）
 * ============================================================
 * 两个纯函数，被 scheduler（workbuddy 派发路径）与 taskRunner（local SDK 路径）共用。
 * 单独成文件是为了避免 scheduler ↔ taskRunner 之间产生循环依赖。
 */

/**
 * 判断用户的决策答案是否属于「授权放行」。
 *
 * 约定：待决策面板里「授权并重新执行 / 允许，继续执行」这类选项
 * 以「授权 / 允许 / 批准 / 同意」开头；用户自定义输入若以这些词开头同样视为放行。
 * 命中后：
 *   - local    路径不再拦截同类工具（否则会「拒绝 → 待决策」无限循环）
 *   - workbuddy 路径用 bypassPermissions 重新派发
 */
export function isPermissionGrant(answer: string | null | undefined): boolean {
  if (!answer) return false;
  const a = answer.trim();
  if (!a) return false;
  if (/^(授权|允许|批准|同意)/.test(a)) return true;
  return /bypassPermissions/i.test(a);
}

/**
 * 判断一段执行结论文本是否表示「因权限不足被拒绝」。
 *
 * 背景（CLI 源码级确认）：
 *   后台 job 使用非交互模式（options.print === true），命中
 *   `shouldAvoidInteractiveApproval` 后走 `denyForNonInteractive`，
 *   权限请求被自动拒绝，并在结果里留下固定措辞（含「非交互模式」）。
 *   因此这类任务不会进入 blocked 状态，只能从文案上识别。
 */
export function looksLikePermissionDenied(text: string | null | undefined): boolean {
  if (!text) return false;
  // 最强特征：CLI 自动拒绝权限时的固定表述，正常结果里几乎不会出现
  if (text.includes('非交互模式')) return true;

  const mentionsPermission = /权限|授权|permission/i.test(text);
  const mentionsDenial = /拒绝|被拒|denied|deny|无法弹出|无法批准|没有可用的权限/i.test(text);
  return mentionsPermission && mentionsDenial;
}

/** 待决策面板中「授权」选项的标准文案（供前后端保持一致的语义） */
export const GRANT_OPTION_TEXT = '授权并重新执行';
