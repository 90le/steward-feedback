# Steward 受限交互预览

包装版本 contained-v1。这是模拟演示，不表示生产功能上线。

[原始源码、测试与署名](https://github.com/90le/steward-feedback/tree/main/prototype-source/issue-10/prd-5-1e9c702f68a7)；原件字节保持不变，安全包装单独计摘要。

静态预览直接打开 index.html。后端演示先将原 server.mjs 在已验证的隔离环境中启动，再运行可信 preview-server.mjs --backend http://127.0.0.1:端口 --port 预览端口；浏览器只打开可信预览服务器。不要把原 server.mjs 返回的裸 HTML 当作受限入口。下载或复制包装时保持原始字节与换行；摘要不符会停止运行。

## 浏览器能力

预览包装能力：生成 HTML 会在 opaque-origin iframe（sandbox 仅 allow-scripts）内运行，父文档及最前置子 CSP 不由生成代码控制。普通 HTML/CSS/JS 和表单控件可用；表单操作使用 type="button" 的 click 处理（必要时 preventDefault()），再更新本地状态或调用受控 fetch。不要依赖原生 submit/requestSubmit 事件路径：当前 sandbox 会在该提交事件前阻止原生提交。不要使用原生页面/锚点导航、form.submit() 外发、弹窗、原生 localStorage/sessionStorage、任意网络或跨框架 DOM。后端模式只开放简单字符串 /api/ 路径（ASCII 字母数字、下划线、连字符和斜线，无 query/hash/点段/百分号编码），fetch 方法为 GET/POST/PUT/PATCH/DELETE，headers 必须是普通对象，仅 JSON Content-Type、X-User-Id、X-Acting-User，身份头仅用于模拟用户，长度至多64。请求体为 JSON 字符串且至多32 KiB，响应必须 JSON且至多256 KiB；最多4个在途、每分钟120次、10秒超时；多页面共用临时代理预算，轮询需合并请求、避免重复定时器并在异常时退避。不带真实credentials，不跟随redirect。不支持 Request/Headers 对象、原生存储或其他能力；超出须明确说明并调整演示，不能放宽sandbox或把HTTP通过当成包装内UI通过。原 server.mjs 的裸页面不是受限入口，浏览器验收应通过可信 preview-server；没有实际跑浏览器就明确未跑。
