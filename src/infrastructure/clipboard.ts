/** Some browsers leave clipboard requests pending while awaiting permission.
 * Bound the request so the editor can use its internal buffer or show recovery instructions.
 */
export async function clipboardRequest<T>(
  request: Promise<T>,
  timeoutMs = 1200,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error("系统剪贴板未响应，请使用键盘快捷键或允许剪贴板访问"),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
