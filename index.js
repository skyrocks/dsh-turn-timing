// Host 半：本插件是纯客户端统计（浏览器侧读会话事件流自己算），宿主不需要做任何事。
//
// 仍然导出空 apply，让 Loader 有一条可挂载的 host 行——与
// @deepseek-ai/dsh-client-ui-settings-plugins 的做法一致：客户端模块系统按
// loader 行把浏览器半侧送出去，没有这一行客户端就不会加载。
export function apply() {}
