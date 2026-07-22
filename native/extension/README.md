# xln for Chrome

The complete static xln wallet packaged as a Chrome Manifest V3 extension.

```bash
bun run native:extension
```

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select
`native/extension/dist`. This unsigned build is for direct testing; Chrome Web Store
distribution is required for normal installation and automatic updates.
