/**
 * 期现瞭望 · 浏览器半
 *
 * 注册为 DSH 官方面板：
 * - `main`            整页（总览 / 套利 / 库存 / 资讯，可下钻品种详情）
 * - `sidebar.panellist` 侧边栏入口（默认隐藏，设置里开启）
 *
 * 所有数据来自 /basis-watch/api，全部读本地文件；页面不做任何外部请求。
 * 图表全部手绘 SVG，不引入第三方图表库。
 */

window.__ModuleLoader__.load({
  id: 'dsh-basis-watch',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useMemo, useRef, useCallback } = React
    const h = React.createElement

    const API = '/basis-watch/api'
    const PANEL_ID = 'basis-watch'
    const CFG_KEY = 'dsh-basis-watch.cfg.v1'

    /** apply 时捕获的插件上下文，供设置项调用 layout 服务。 */
    let pluginCtx = null

    /** 面板是否挂载中（= 用户当前在本插件内），快捷键据此决定是否顺带跳回会话。 */
    let panelActive = false

    /** 本插件自己的弹层（术语说明）是否打开；打开时快捷键不响应。 */
    let panelModalOpen = false

