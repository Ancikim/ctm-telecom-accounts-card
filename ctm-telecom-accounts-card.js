/**
 * CTM 电信套餐卡片（多账号）  v1.0.0
 * Home Assistant 自定义卡片 · 依赖 china_telecom 集成
 * 用法: type: custom:ctm-telecom-accounts-card
 * 许可: MIT
 */
class CtmTelecomAccountsCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement("ctm-telecom-accounts-card-editor");
  }

  static getStubConfig() {
    return {
      type: "custom:ctm-telecom-accounts-card",
      title: "电信套餐",
      balance_warning_below: 20,
      usage_warning_percent: 80,
      usage_danger_percent: 95,
      show_all_entities: false,
    };
  }

  setConfig(config) {
    this.config = {
      title: "电信套餐",
      balance_warning_below: 20,
      usage_warning_percent: 80,
      usage_danger_percent: 95,
      show_all_entities: false,
      ...config,
    };
    if (this.config.device_id === "") delete this.config.device_id;
    const rawDevices = Array.isArray(this.config.devices) ? this.config.devices : [];
    this.devices = rawDevices
      .map((item) => (typeof item === "string" ? { device_id: item } : item))
      .filter((item) => item && item.device_id);
    const storedId = this.readActiveDevice();
    const deviceIds = this.devices.map((item) => item.device_id);
    this.activeDeviceId = deviceIds.includes(storedId)
      ? storedId
      : (this.devices[0]?.device_id || this.config.device_id || null);
    this.detailsOpen = this.readDetailsOpen();
    this.entities = [];
    this.device = null;
    this.discoveryKey = "";
    this.render();
  }

  readActiveDevice() {
    try { return localStorage.getItem("ctm-active-device"); } catch (error) { return null; }
  }

  writeActiveDevice(id) {
    try { localStorage.setItem("ctm-active-device", id); } catch (error) { /* ignore */ }
  }

  readDetailsOpen() {
    try { return localStorage.getItem("ctm-details-open") === "1"; } catch (error) { return false; }
  }

  writeDetailsOpen(value) {
    try { localStorage.setItem("ctm-details-open", value ? "1" : "0"); } catch (error) { /* ignore */ }
  }

  deviceLabel(item) {
    if (item.name) return item.name;
    const device = this.devicesById?.[item.device_id];
    const auto = (device?.name_by_user || device?.name || "").replace(/\s*套餐信息$/, "").trim();
    return auto || item.device_id.slice(0, 8);
  }

  connectedCallback() {
    if (this._moreInfoHandler) return;
    this._moreInfoHandler = (event) => {
      const target = event.target.closest("[data-entity-id]");
      if (!target) return;

      const entityId = target.dataset.entityId;
      if (!entityId) return;
      event.stopPropagation();
      this.dispatchEvent(new CustomEvent("hass-more-info", {
        detail: { entityId },
        bubbles: true,
        composed: true,
      }));
    };
    this.addEventListener("click", this._moreInfoHandler);

    this._deviceHandler = (event) => {
      const target = event.target.closest("[data-device-id]");
      if (!target) return;
      event.stopPropagation();
      this.switchDevice(target.dataset.deviceId);
    };
    this.addEventListener("click", this._deviceHandler);

    this._detailsHandler = (event) => {
      const target = event.target.closest("[data-details-toggle]");
      if (!target) return;
      event.stopPropagation();
      this.detailsOpen = !this.detailsOpen;
      this.writeDetailsOpen(this.detailsOpen);
      this.render(true);
    };
    this.addEventListener("click", this._detailsHandler);
  }

  disconnectedCallback() {
    if (!this._moreInfoHandler) return;
    this.removeEventListener("click", this._moreInfoHandler);
    this._moreInfoHandler = null;
    if (this._deviceHandler) {
      this.removeEventListener("click", this._deviceHandler);
      this._deviceHandler = null;
    }
    if (this._detailsHandler) {
      this.removeEventListener("click", this._detailsHandler);
      this._detailsHandler = null;
    }
  }

  set hass(hass) {
    this._hass = hass;
    this.discoverEntities();
    if (this._renderQueued) return;
    this._renderQueued = true;
    requestAnimationFrame(() => {
      this._renderQueued = false;
      this.render();
    });
  }

  getCardSize() {
    return this.config?.show_all_entities ? 6 : 4;
  }

  async discoverEntities() {
    if (!this._hass?.callWS) return;
    const wantedId = this.activeDeviceId || this.config.device_id;

    // 命中注册表缓存：同步换表，切账号不再等网络（缓存 10 分钟后自动刷新）
    if (this._regCache && Date.now() - this._regCache.time < 600000) {
      this.applyRegistry(this._regCache.devices, this._regCache.registry, wantedId);
      this.render();
      return;
    }
    if (this.discovering) return;

    this.discovering = true;
    const token = this.discoveryToken || 0;
    try {
      const [devices, registry] = await Promise.all([
        this._hass.callWS({ type: "config/device_registry/list" }),
        this._hass.callWS({ type: "config/entity_registry/list" }),
      ]);
      this._regCache = { devices, registry, time: Date.now() };
      if (token !== (this.discoveryToken || 0)) return;
      this.applyRegistry(devices, registry, wantedId);
    } catch (error) {
      this.discoveryError = error;
    } finally {
      this.discovering = false;
      this.render(true);
    }
  }

  applyRegistry(devices, registry, wantedId) {
    const telecomDevice = wantedId
      ? devices.find((device) => device.id === wantedId)
      : this.findTelecomDevice(devices, registry);
    const deviceId = telecomDevice?.id || wantedId;
    this.devicesById = Object.fromEntries(devices.map((device) => [device.id, device]));
    this.device = telecomDevice || null;
    const list = registry
      .filter((entry) => entry.device_id === deviceId)
      .filter((entry) => !entry.disabled_by && !entry.hidden_by)
      .filter((entry) => this._hass.states[entry.entity_id])
      .sort((a, b) => this.sortRank(a).localeCompare(this.sortRank(b)));
    const changed = list.length !== this.entities.length
      || list.some((entry, index) => entry.entity_id !== this.entities[index]?.entity_id);
    this.entities = list;
    this.discoveryKey = `${deviceId}|${list.length}`;
    this.discoveryError = null;
    if (changed) this.render(true);
    return changed;
  }

  findTelecomDevice(devices, registry) {
    const text = (device) => [
      device.name_by_user,
      device.name,
      device.manufacturer,
      device.model,
    ].filter(Boolean).join(" ");

    const candidates = devices.filter((device) =>
      /CTM|中国电信|电信|china[_ -]?telecom/i.test(text(device))
    );
    return candidates
      .map((device) => ({
        device,
        count: registry.filter((entry) => entry.device_id === device.id && entry.entity_id?.startsWith("sensor.")).length,
      }))
      .sort((a, b) => b.count - a.count)[0]?.device || null;
  }

  sortRank(entry) {
    const name = this.entryName(entry);
    const entityId = entry.entity_id;
    // 顺序：账户/消费/积分 → 流量(总量→已用→剩余→超量，主套餐→通用→专用) → 通话(总量→已用→剩余)
    // 通用/专用必须排在「流量总量」等之前匹配，否则会被宽泛规则抢走
    const rank = [
      [/账户余额|zhang_hu_yu_e/, "01"],
      [/本月消费|ben_yue_xiao_fei/, "02"],
      [/积分|ji_fen/, "03"],
      [/流量使用率|liu_liang_shi_yong_lu/, "04"],
      [/通用流量总量|tong_yong_liu_liang_zong_liang/, "12"],
      [/通用流量已用|tong_yong_liu_liang_yi_yong/, "13"],
      [/通用流量超量|tong_yong_liu_liang_chao_liang/, "14"],
      [/专用流量总量|zhuan_yong_liu_liang_zong_liang/, "15"],
      [/专用流量已用|zhuan_yong_liu_liang_yi_yong/, "16"],
      [/专用流量超量|zhuan_yong_liu_liang_chao_liang/, "17"],
      [/流量总量|liu_liang_zong_liang/, "08"],
      [/流量已用|liu_liang_yi_yong/, "09"],
      [/流量剩余|liu_liang_sheng_yu/, "10"],
      [/流量超量|liu_liang_chao_liang/, "11"],
      [/通话使用率|tong_hua_shi_yong_lu/, "20"],
      [/通话总量|tong_hua_zong_liang/, "21"],
      [/通话已用|tong_hua_yi_yong/, "22"],
      [/通话剩余|tong_hua_sheng_yu/, "23"],
    ].find(([pattern]) => pattern.test(name) || pattern.test(entityId))?.[1] || "99";
    return `${rank}-${entityId}`;
  }

  entryName(entry) {
    return entry.name || entry.original_name || this._hass?.states?.[entry.entity_id]?.attributes?.friendly_name || entry.entity_id;
  }

  label(entry) {
    return this.entryName(entry)
      .replace(/^\d{3}[*\d_]+ ?/, "")
      .replace(/^电信/, "")
      .trim();
  }

  state(entityId) {
    return this._hass?.states?.[entityId];
  }

  findEntity(patterns) {
    return this.entities.find((entry) => {
      const text = `${entry.entity_id} ${this.entryName(entry)}`;
      return patterns.some((pattern) => pattern.test(text));
    });
  }

  value(entry) {
    const state = entry && this.state(entry.entity_id);
    if (!state) return "--";
    const unit = state.attributes?.unit_of_measurement || "";
    return `${state.state}${unit ? ` ${unit}` : ""}`;
  }

  numberValue(entry) {
    const state = entry && this.state(entry.entity_id);
    const value = Number.parseFloat(state?.state);
    return Number.isFinite(value) ? value : null;
  }

  render(force = false) {
    if (!this.config) return;
    const key = JSON.stringify({
      config: this.config,
      device: this.activeDeviceId,
      detailsOpen: this.detailsOpen,
      entities: this.entities.map((entry) => [entry.entity_id, this.state(entry.entity_id)?.state]),
      discovering: this.discovering,
      error: Boolean(this.discoveryError),
    });
    if (!force && this.lastRenderKey === key) return;
    this.lastRenderKey = key;

    const balance = this.findEntity([/账户余额|zhang_hu_yu_e/]);
    const cost = this.findEntity([/本月消费|ben_yue_xiao_fei/]);
    const points = this.findEntity([/积分|ji_fen/]);
    const flowRate = this.findEntity([/流量使用率|liu_liang_shi_yong_lu/]);
    const callRate = this.findEntity([/通话使用率|tong_hua_shi_yong_lu/]);

    this.innerHTML = `
      <ha-card>
        <div class="ctm-card">
          <div class="header">
            <div>
              <div class="title">${this.escape(this.config.title || "电信套餐")}</div>
              ${this.devices.length > 1
                ? `<div class="devices">${this.devices.map((item) => `<div class="dev-pill${item.device_id === this.activeDeviceId ? " on" : ""}" data-device-id="${this.escape(item.device_id)}">${this.escape(this.deviceLabel(item))}</div>`).join("")}</div>`
                : `<div class="subtitle">${this.escape(this.device?.name_by_user || this.device?.name || "请选择中国电信套餐设备")}</div>`}
            </div>
            <div class="logo"><ha-icon icon="mdi:sim"></ha-icon></div>
          </div>
          ${this.discoveryError ? `<div class="message">实体读取失败：${this.escape(this.discoveryError.message || this.discoveryError)}</div>` : ""}
          ${this.discovering && !this.entities.length ? `<div class="message">正在读取设备实体...</div>` : ""}
          ${!this.discovering && !this.entities.length ? `<div class="message">未找到可显示实体，请在卡片编辑器选择 CTM 电信套餐设备。</div>` : ""}
          ${this.entities.length ? `
            <div class="summary">
              ${this.metric("账户余额", balance, "mdi:wallet-outline", `primary${this.isBalanceLow(balance) ? " warning" : ""}`)}
              ${this.metric("本月消费", cost, "mdi:cash")}
              ${this.metric("积分", points, "mdi:star-circle-outline")}
            </div>
            <div class="meters">
              ${this.progress("流量", flowRate, this.findEntity([/流量剩余|liu_liang_sheng_yu/]), this.findEntity([/流量总量|liu_liang_zong_liang/]))}
              ${this.progress("通话", callRate, this.findEntity([/通话剩余|tong_hua_sheng_yu/]), this.findEntity([/通话总量|tong_hua_zong_liang/]))}
            </div>
            <div class="groups">
              ${this.flowSection()}
              ${this.group("通话", [/通话剩余|通话已用|通话总量|tong_hua_(sheng_yu|yi_yong|zong_liang)/])}
              ${this.config.show_all_entities ? this.group("其他", [/.*/], true) : ""}
            </div>
          ` : ""}
        </div>
        <style>
          .ctm-card {
            --ctm-blue: #005bac;
            --ctm-sky: #00a3e0;
            --ctm-orange: #f59e0b;
            --ctm-red: #e60012;
            --ctm-soft-blue: rgba(0, 91, 172, 0.07);
            --ctm-soft-sky: rgba(0, 163, 224, 0.10);
            padding: 14px;
            color: var(--primary-text-color);
          }
          .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            margin-bottom: 8px;
          }
          .title {
            font-size: 15.5px;
            font-weight: 700;
            letter-spacing: 0.2px;
          }
          .subtitle {
            color: var(--secondary-text-color);
            font-size: 13px;
            margin-top: 4px;
          }
          .ctm-card .devices {
            display: flex;
            gap: 5px;
            margin-top: 4px;
            flex-wrap: wrap;
          }
          .ctm-card .dev-pill {
            font-size: 11.5px;
            line-height: 1.4;
            padding: 2px 10px;
            border-radius: 999px;
            background: var(--ctm-soft-blue);
            color: var(--secondary-text-color);
            cursor: pointer;
            white-space: nowrap;
            user-select: none;
            transition: background 0.15s, color 0.15s, box-shadow 0.15s;
          }
          .ctm-card .dev-pill:hover {
            background: var(--ctm-soft-sky);
          }
          .ctm-card .dev-pill.on {
            background: linear-gradient(135deg, var(--ctm-blue), var(--ctm-sky));
            color: #fff;
            font-weight: 650;
            box-shadow: 0 3px 8px rgba(0, 91, 172, 0.3);
          }
          .logo {
            width: 34px;
            height: 34px;
            border-radius: 10px;
            background: linear-gradient(135deg, var(--ctm-blue), var(--ctm-sky));
            color: #fff;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 4px 12px rgba(0, 91, 172, 0.28);
            flex-shrink: 0;
          }
          .logo ha-icon {
            --mdc-icon-size: 19px;
          }
          .message {
            color: var(--secondary-text-color);
            padding: 12px 0 4px;
          }
          .hero {
            position: relative;
            overflow: hidden;
            border-radius: 13px;
            padding: 8px 13px;
            background: linear-gradient(130deg, var(--ctm-blue) 0%, #0072c6 55%, var(--ctm-sky) 100%);
            color: #fff;
            margin-bottom: 8px;
            box-shadow: 0 6px 16px rgba(0, 91, 172, 0.25);
            cursor: pointer;
          }
          .hero.warning {
            background: linear-gradient(130deg, #c81e2b, #e6532e);
            box-shadow: 0 6px 16px rgba(200, 30, 43, 0.3);
          }
          .hero::after {
            content: "";
            position: absolute;
            right: -30px;
            top: -42px;
            width: 130px;
            height: 130px;
            border-radius: 50%;
            background: rgba(255, 255, 255, 0.13);
          }
          .hero::before {
            content: "";
            position: absolute;
            right: 58px;
            bottom: -52px;
            width: 90px;
            height: 90px;
            border-radius: 50%;
            background: rgba(255, 255, 255, 0.08);
          }
          .hero-top {
            display: flex;
            align-items: center;
            gap: 10px;
            position: relative;
            z-index: 1;
          }
          .hero-icon {
            width: 28px;
            height: 28px;
            border-radius: 9px;
            background: rgba(255, 255, 255, 0.2);
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
          }
          .hero-icon ha-icon {
            --mdc-icon-size: 17px;
            color: #fff;
          }
          .hero-label {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 11.5px;
            font-weight: 600;
            color: rgba(255, 255, 255, 0.94);
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
          }
          .hero-value {
            font-size: 22px;
            font-weight: 750;
            line-height: 1.15;
            margin-top: 1px;
            color: #fff;
            text-shadow: 0 1px 3px rgba(0, 0, 0, 0.16);
            font-variant-numeric: tabular-nums;
          }
          .hero-unit {
            font-size: 12.5px;
            font-weight: 600;
            opacity: 0.85;
            margin-left: 3px;
          }
          .hero-badge {
            background: #fff;
            color: #c81e2b;
            padding: 1px 8px;
            border-radius: 999px;
            font-size: 11px;
            font-weight: 700;
            line-height: 1.5;
            white-space: nowrap;
            box-shadow: 0 1px 4px rgba(0, 0, 0, 0.16);
          }
          .summary {
            display: grid;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 7px;
            margin-bottom: 10px;
          }
          .metric {
            border: none;
            border-radius: 11px;
            background: var(--ctm-soft-blue);
            padding: 7px 9px;
            min-width: 0;
            transition: background 0.15s, box-shadow 0.15s;
          }
          .metric-head {
            display: flex;
            align-items: center;
            gap: 5px;
            min-width: 0;
          }
          .metric.primary {
            background: linear-gradient(135deg, var(--ctm-blue), var(--ctm-sky));
            box-shadow: 0 4px 10px rgba(0, 91, 172, 0.22);
          }
          .metric.primary.warning {
            background: linear-gradient(135deg, #c81e2b, #e6532e);
            box-shadow: 0 4px 10px rgba(200, 30, 43, 0.28);
          }
          .metric.primary .metric-head ha-icon {
            color: #fff;
          }
          .metric.primary .metric-label {
            color: rgba(255, 255, 255, 0.92);
          }
          .metric.primary .metric-value {
            color: #fff;
            font-size: 16px;
            font-weight: 750;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
          }
          .metric-flag {
            background: #fff;
            color: #c81e2b;
            border-radius: 999px;
            padding: 0 5px;
            font-size: 9.5px;
            font-weight: 700;
            line-height: 1.6;
            flex-shrink: 0;
          }
          .metric[data-entity-id],
          .clickable-value,
          .entity-row[data-entity-id] {
            cursor: pointer;
          }
          .metric[data-entity-id]:hover,
          .entity-row[data-entity-id]:hover {
            box-shadow: 0 3px 10px rgba(0, 91, 172, 0.12);
          }
          .metric:not(.primary):hover {
            background: var(--ctm-soft-sky);
          }
          .metric-head ha-icon {
            --mdc-icon-size: 15px;
            color: var(--ctm-sky);
            flex-shrink: 0;
          }
          .metric-label {
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }
          .metric-label,
          .row-name,
          .meter-top {
            color: var(--secondary-text-color);
            font-size: 11.5px;
          }
          .metric-value {
            font-size: 15px;
            font-weight: 700;
            line-height: 1.2;
            margin-top: 3px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            font-variant-numeric: tabular-nums;
          }
          .meters {
            display: grid;
            gap: 8px;
            margin-bottom: 10px;
          }
          .meter-top,
          .meter-detail {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 12px;
          }
          .meter-detail {
            color: var(--primary-text-color);
            font-size: 11.5px;
            margin-top: 3px;
          }
          .clickable-value:hover {
            color: var(--ctm-blue);
            text-decoration: underline;
            text-underline-offset: 2px;
          }
          .meter-rate.badge {
            background: var(--ctm-soft-blue);
            color: var(--ctm-blue);
            padding: 1px 10px;
            border-radius: 999px;
            font-weight: 700;
            font-size: 12px;
          }
          .meter.warn .meter-rate.badge {
            background: rgba(245, 158, 11, 0.14);
            color: #b45309;
          }
          .meter.danger .meter-rate.badge {
            background: rgba(230, 0, 18, 0.1);
            color: var(--ctm-red);
          }
          .bar {
            height: 8px;
            background: rgba(0, 91, 172, 0.12);
            border-radius: 999px;
            overflow: hidden;
            margin-top: 6px;
          }
          .fill {
            height: 100%;
            width: var(--value);
            max-width: 100%;
            background: var(--meter-color, linear-gradient(90deg, var(--ctm-blue), var(--ctm-sky)));
            border-radius: inherit;
            transition: width 0.4s ease;
          }
          .meter.warn {
            --meter-color: linear-gradient(90deg, #d97706, #fbbf24);
          }
          .meter.danger {
            --meter-color: linear-gradient(90deg, #b91c1c, #ef4444);
          }
          .details-toggle {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 4px;
            padding: 6px 0;
            border-radius: 10px;
            background: var(--ctm-soft-blue);
            color: var(--ctm-blue);
            font-size: 12px;
            font-weight: 650;
            cursor: pointer;
            user-select: none;
            transition: background 0.15s;
          }
          .details-toggle:hover {
            background: var(--ctm-soft-sky);
          }
          .details-toggle ha-icon {
            --mdc-icon-size: 16px;
          }
          .groups {
            display: grid;
            gap: 4px;
            margin-top: 5px;
          }
          .group-title {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 12px;
            font-weight: 700;
            margin: 0 0 2px;
            color: var(--ctm-blue);
          }
          .group-title::before {
            content: "";
            width: 3px;
            height: 12px;
            border-radius: 2px;
            background: linear-gradient(180deg, var(--ctm-blue), var(--ctm-sky));
          }
          .entity-grid {
            display: grid;
            grid-template-columns: repeat(4, minmax(0, 1fr));
            gap: 5px 3px;
          }
          .entity-row {
            background: var(--ctm-soft-sky);
            border: none;
            border-radius: 8px;
            padding: 3px 5px;
            min-width: 0;
            display: flex;
            flex-direction: column;
            align-items: stretch;
            justify-content: center;
            gap: 0;
            line-height: 1.25;
            transition: background 0.15s, box-shadow 0.15s;
          }
          .entity-row.empty {
            background: rgba(120, 130, 145, 0.09);
          }
          .entity-row.empty .row-value {
            opacity: 0.42;
          }
          .entity-row.calc {
            background: rgba(0, 163, 224, 0.09);
          }
          .entity-row.calc .row-value {
            font-style: italic;
            opacity: 0.82;
          }
          .entity-row[data-kind="general"],
          .entity-row[data-kind="special"] {
            background: rgba(0, 163, 224, 0.06);
          }
          .entity-row:hover {
            background: rgba(0, 163, 224, 0.18);
            box-shadow: 0 2px 6px rgba(0, 91, 172, 0.12);
          }
          .row-name {
            width: 100%;
            min-width: 0;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            font-size: 9.5px;
            opacity: 0.72;
          }
          .row-value {
            width: 100%;
            font-weight: 650;
            font-size: 11px;
            margin-top: 0;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            font-variant-numeric: tabular-nums;
          }
          @media (max-width: 480px) {
            .ctm-card {
              padding: 12px;
            }
            .summary {
              gap: 6px;
            }
            .entity-grid {
              gap: 4px;
            }
            .metric {
              padding: 6px 7px;
            }
            .metric-head ha-icon {
              --mdc-icon-size: 13px;
            }
            .metric-head {
              gap: 4px;
            }
            .metric-label,
            .meter-top {
              font-size: 10.5px;
            }
            .metric-value {
              font-size: 13px;
              margin-top: 2px;
            }
            .metric.primary .metric-value {
              font-size: 14px;
            }
            .entity-row {
              padding: 3px 6px;
            }
            .row-value {
              font-size: 11px;
            }
            .meter-detail {
              font-size: 11.5px;
            }
            .hero-value {
              font-size: 20px;
            }
          }
          @media (max-width: 360px) {
            .summary,
            .entity-grid {
              gap: 3px;
            }
            .metric {
              padding: 7px;
            }
            .entity-row {
              padding: 3px 6px;
            }
          }
        </style>
      </ha-card>
    `;
    this.bindInteractions();
  }

  switchDevice(id) {
    if (!id || id === this.activeDeviceId) return;
    this.writeActiveDevice(id);
    this.activeDeviceId = id;
    this.discoveryToken = (this.discoveryToken || 0) + 1;
    this.discoveryError = null;
    if (this._regCache && Date.now() - this._regCache.time < 600000) {
      this.applyRegistry(this._regCache.devices, this._regCache.registry, id);
      this.render(true);
      return;
    }
    this.entities = [];
    this.device = null;
    this.discoveryKey = "";
    this.render(true);
    setTimeout(() => this.discoverEntities(), 0);
  }

  bindInteractions() {
    this.querySelectorAll("[data-device-id]").forEach((node) => {
      node.onclick = (event) => {
        event.stopPropagation();
        this.switchDevice(node.dataset.deviceId);
      };
    });
    this.querySelectorAll("[data-details-toggle]").forEach((node) => {
      node.onclick = (event) => {
        event.stopPropagation();
        this.detailsOpen = !this.detailsOpen;
        this.writeDetailsOpen(this.detailsOpen);
        this.render(true);
      };
    });
  }

  detailsToggle() {
    const icon = this.detailsOpen ? "mdi:chevron-up" : "mdi:chevron-down";
    const text = this.detailsOpen ? "收起明细" : "流量 / 通话明细";
    return `
      <div class="details-toggle" data-details-toggle>
        <ha-icon icon="${icon}"></ha-icon>
        <span>${text}</span>
      </div>
    `;
  }

  hero(entry) {
    const low = this.isBalanceLow(entry);
    const state = entry && this.state(entry.entity_id);
    const unit = state?.attributes?.unit_of_measurement || "";
    const num = this.numberValue(entry);
    const numText = Number.isFinite(num) ? `${num}` : (state ? `${state.state}` : "--");
    return `
      <div class="hero${low ? " warning" : ""}"${this.entityAttr(entry)}>
        <div class="hero-top">
          <div class="hero-icon"><ha-icon icon="mdi:wallet-outline"></ha-icon></div>
          <div class="hero-main">
            <div class="hero-label">
              <span>账户余额</span>
              ${low ? `<span class="hero-badge">余额不足</span>` : ""}
            </div>
            <div class="hero-value">${this.escape(numText)}<span class="hero-unit">${this.escape(unit)}</span></div>
          </div>
        </div>
      </div>
    `;
  }

  metric(label, entry, icon, variant = "") {
    const low = variant.includes("warning");
    return `
      <div class="metric${variant ? ` ${variant}` : ""}"${this.entityAttr(entry)}>
        <div class="metric-head">
          <ha-icon icon="${icon}"></ha-icon>
          <span class="metric-label">${this.escape(label)}</span>
          ${low ? `<span class="metric-flag">不足</span>` : ""}
        </div>
        <div class="metric-value">${this.escape(this.value(entry))}</div>
      </div>
    `;
  }

  progress(label, rateEntry, remainEntry, totalEntry) {
    const rate = this.numberValue(rateEntry);
    const percent = rate === null ? 0 : Math.max(0, Math.min(100, rate));
    const level = this.usageLevel(rate);
    return `
      <div class="meter ${level}">
        <div class="meter-top">
          <span>${this.escape(label)}</span>
          ${this.clickableValue(rateEntry, "meter-rate badge")}
        </div>
        <div class="bar"><div class="fill" style="--value:${percent}%"></div></div>
        <div class="meter-detail">
          <span>剩余 ${this.clickableValue(remainEntry)}</span>
          <span>总量 ${this.clickableValue(totalEntry)}</span>
        </div>
      </div>
    `;
  }

  clickableValue(entry, extraClass = "") {
    const className = `clickable-value${extraClass ? ` ${extraClass}` : ""}`;
    return `<span class="${className}"${this.entityAttr(entry)}>${this.escape(this.value(entry))}</span>`;
  }

  isBalanceLow(entry) {
    const threshold = Number.parseFloat(this.config.balance_warning_below);
    const value = this.numberValue(entry);
    return Number.isFinite(threshold) && threshold > 0 && value !== null && value < threshold;
  }

  usageLevel(value) {
    if (value === null) return "";
    const warning = Number.parseFloat(this.config.usage_warning_percent);
    const danger = Number.parseFloat(this.config.usage_danger_percent);
    if (Number.isFinite(danger) && danger > 0 && value >= danger) return "danger";
    if (
      Number.isFinite(warning)
      && warning > 0
      && value >= warning
      && (!Number.isFinite(danger) || danger <= 0 || warning < danger)
    ) return "warn";
    return "";
  }

  flowEntity(kind, metric) {
    const suffix = {
      main: `_liu_liang_${metric}`,
      general: `_tong_yong_liu_liang_${metric}`,
      special: `_zhuan_yong_liu_liang_${metric}`,
    }[kind];
    return this.entities.find((entry) => {
      const id = entry.entity_id || "";
      if (!id.endsWith(suffix)) return false;
      if (kind === "main" && /_tong_yong_|_zhuan_yong_/.test(id)) return false;
      return true;
    });
  }

  flowNumbers(kind) {
    const get = (metric) => this.numberValue(this.flowEntity(kind, metric));
    return {
      total: get("zong_liang"),
      used: get("yi_yong"),
      remain: get("sheng_yu"),
      over: get("chao_liang"),
    };
  }

  flowUnitOf(kind) {
    for (const metric of ["zong_liang", "yi_yong", "sheng_yu", "chao_liang"]) {
      const entry = this.flowEntity(kind, metric);
      const unit = entry ? this.state(entry.entity_id)?.attributes?.unit_of_measurement : null;
      if (unit) return unit;
    }
    return "";
  }

  // 缺哪项就用同类已有项推算：剩余=总量-已用、超量=max(0,已用-总量)、已用=总量-剩余、总量=已用+剩余
  flowDerived(kind, metric) {
    const { total, used, remain } = this.flowNumbers(kind);
    const round = (value) => Math.round(value * 100) / 100;
    if (metric === "sheng_yu" && total !== null && used !== null) return round(total - used);
    if (metric === "chao_liang" && total !== null && used !== null) return round(Math.max(0, used - total));
    if (metric === "yi_yong" && total !== null && remain !== null) return round(total - remain);
    if (metric === "zong_liang" && used !== null && remain !== null) return round(used + remain);
    return null;
  }

  flowCell(name, kind, metric) {
    const entry = this.flowEntity(kind, metric);
    const derived = entry ? null : this.flowDerived(kind, metric);
    const computed = !entry && derived !== null;
    const unit = this.flowUnitOf(kind);
    const text = entry
      ? this.value(entry)
      : (computed ? `${derived}${unit ? ` ${unit}` : ""}` : "--");
    const cls = entry ? "" : (computed ? " calc" : " empty");
    return `
      <div class="entity-row${cls}" data-kind="${kind}"${this.entityAttr(entry)}>
        <div class="row-name">${this.escape(name)}</div>
        <div class="row-value">${this.escape(text)}</div>
      </div>
    `;
  }

  flowSection() {
    if (!this.entities.some((entry) => /liu_liang/.test(entry.entity_id || ""))) return "";
    const metrics = [
      ["总量", "zong_liang"],
      ["已用", "yi_yong"],
      ["剩余", "sheng_yu"],
      ["超量", "chao_liang"],
    ];
    const row = (prefix, kind) => metrics
      .map(([name, metric]) => this.flowCell(prefix + name, kind, metric))
      .join("");
    return `
      <div>
        <div class="group-title">流量</div>
        <div class="entity-grid">
          ${row("套餐", "main")}
          ${row("通用", "general")}
          ${row("专用", "special")}
        </div>
      </div>
    `;
  }

  group(title, patterns, includeOnlyUnmatched = false) {
    const alreadyShown = [
      /账户余额|zhang_hu_yu_e/,
      /本月消费|ben_yue_xiao_fei/,
      /积分|ji_fen/,
      /使用率|shi_yong_lu/,
      /流量剩余|流量已用|流量总量|流量超量|liu_liang_(sheng_yu|yi_yong|zong_liang|chao_liang)/,
      /通话剩余|通话已用|通话总量|tong_hua_(sheng_yu|yi_yong|zong_liang)/,
    ];
    const rows = this.entities.filter((entry) => {
      const text = `${entry.entity_id} ${this.entryName(entry)}`;
      if (includeOnlyUnmatched && alreadyShown.some((pattern) => pattern.test(text))) return false;
      return patterns.some((pattern) => pattern.test(text));
    });
    if (!rows.length) return "";
    return `
      <div>
        <div class="group-title">${this.escape(title)}</div>
        <div class="entity-grid">
          ${rows.map((entry) => `
            <div class="entity-row"${this.entityAttr(entry)}>
              <div class="row-name">${this.escape(this.label(entry))}</div>
              <div class="row-value">${this.escape(this.value(entry))}</div>
            </div>
          `).join("")}
        </div>
      </div>
    `;
  }

  escape(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    }[char]));
  }

  entityAttr(entry) {
    return entry?.entity_id ? ` data-entity-id="${this.escape(entry.entity_id)}"` : "";
  }
}

class CtmTelecomCardEditor extends HTMLElement {
  setConfig(config) {
    this.config = {
      title: "电信套餐",
      balance_warning_below: 20,
      usage_warning_percent: 80,
      usage_danger_percent: 95,
      show_all_entities: false,
      ...config,
    };
    if (this.config.device_id === "") delete this.config.device_id;
    this.render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) {
      this._form.hass = hass;
      return;
    }
    this.render();
  }

  render() {
    if (!this._hass || !this.config) return;
    if (!this._form) {
      this.innerHTML = `<ha-form></ha-form>`;
      this._form = this.querySelector("ha-form");
      this._form.schema = [
        { name: "title", selector: { text: {} } },
        { name: "devices", selector: { device: { multiple: true } } },
        { name: "balance_warning_below", selector: { number: { min: 0, mode: "box", unit_of_measurement: "元" } } },
        { name: "usage_warning_percent", selector: { number: { min: 0, max: 100, mode: "box", unit_of_measurement: "%" } } },
        { name: "usage_danger_percent", selector: { number: { min: 0, max: 100, mode: "box", unit_of_measurement: "%" } } },
        { name: "show_all_entities", selector: { boolean: {} } },
      ];
      this._form.computeLabel = (schema) => ({
        title: "标题",
        devices: "电信套餐设备（可多选，按顺序显示为账号标签）",
        balance_warning_below: "余额低于此值标红",
        usage_warning_percent: "使用率提醒百分比",
        usage_danger_percent: "使用率危险百分比",
        show_all_entities: "显示全部实体",
      }[schema.name] || schema.name);
      this._form.addEventListener("value-changed", (event) => {
        event.stopPropagation();
        const value = { ...event.detail.value };
        if (Array.isArray(value.devices)) {
          const prev = Array.isArray(this.config.devices) ? this.config.devices : [];
          value.devices = value.devices.map((id) => {
            const old = prev.find((item) => (typeof item === "string" ? item : item?.device_id) === id);
            const name = typeof old === "object" ? old?.name : undefined;
            return name ? { device_id: id, name } : { device_id: id };
          });
        }
        const nextConfig = { ...this.config, ...value };
        if (JSON.stringify(nextConfig) === JSON.stringify(this.config)) return;
        this.config = nextConfig;
        this.dispatchEvent(new CustomEvent("config-changed", {
          detail: { config: this.config },
          bubbles: true,
          composed: true,
        }));
      });
    }
    this._form.hass = this._hass;
    const data = { ...this.config };
    const list = Array.isArray(this.config.devices)
      ? this.config.devices.map((item) => (typeof item === "string" ? item : item?.device_id)).filter(Boolean)
      : (this.config.device_id ? [this.config.device_id] : []);
    data.devices = list;
    this._form.data = data;
  }
}

customElements.define("ctm-telecom-accounts-card", CtmTelecomAccountsCard);
customElements.define("ctm-telecom-accounts-card-editor", CtmTelecomCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "ctm-telecom-accounts-card",
  name: "CTM 电信卡片（多账号）",
  description: "支持多个电信套餐设备，点击账号标签切换，实体自动重读。",
});
