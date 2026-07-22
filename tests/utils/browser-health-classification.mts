const CHROMIUM_WEBGL_READPIXELS_DIAGNOSTIC =
  /^\[\.WebGL-0x[0-9a-fA-F]+\]GL Driver Message \(OpenGL, Performance, GL_CLOSE_PATH_NV, High\): GPU stall due to ReadPixels(?: \(this message will no longer repeat\))?$/;

export const isBenignConsoleMessage = (message: string): boolean =>
  message === 'Ignoring Event: localhost' ||
  CHROMIUM_WEBGL_READPIXELS_DIAGNOSTIC.test(message);
