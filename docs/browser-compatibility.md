# Browser Compatibility

| Browser | Status | Notes |
| --- | --- | --- |
| Google Chrome | 已本地加载 | Primary target. Manual beta testing should use unpacked extension loading. |
| Microsoft Edge | 静态检查 | Chromium-based and likely compatible, but not yet treated as the primary beta target. |
| Brave / other Chromium browsers | 未评估 | May work if Manifest V3 Chrome APIs match, but needs manual verification. |
| Firefox | 未评估 | Not expected to work without API and manifest adaptation. |
| Safari | 未评估 | Not supported in the current project. |

## Known Page Limitations

- Ordinary HTML webpages are the main supported target.
- Chrome PDF Viewer, Canvas-based readers, scanned text, and complex web readers may not expose selections and text nodes in a way the content script can use reliably.
- Other selection/translation extensions may show their own panels at the same time. This is allowed in the current design.
