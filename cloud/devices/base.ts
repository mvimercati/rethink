import { type Metadata } from '../thinq'
import type { Connection, DeviceDiscovery } from '../homeassistant'

// Strings shown in Home Assistant in another language, keyed by the English text: entity names, the device
// name, and the options and values of selects and enum sensors. A device lists only what it translates.
export type Translations = Record<string, Record<string, string>>

// Home Assistant's slugify, enough for the ASCII names used here.
const slug = (s: string) =>
    s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '')

export default class HADevice {
    config: DeviceDiscovery | undefined

    static config(meta: Metadata, deviceInfo?: object): DeviceDiscovery {
        return {
            availability: [{ topic: '$this/availability' }, { topic: '$rethink/availability' }],
            availability_mode: 'all',
            device: {
                identifiers: '$deviceid',
                manufacturer: 'LG',
                model: meta.modelName,
                sw_version: meta.swVersion,
                ...(deviceInfo || {}),
            },
            origin: {
                name: 'rethink',
                support_url: 'https://github.com/anszom/rethink',
            },
            components: {},
        }
    }

    // Overridden by devices that ship translations, see `Translations`.
    static translations: Translations = {}

    private readonly dict: Record<string, string> | undefined
    private readonly reverseDict: Map<string, string> | undefined

    constructor(
        readonly HA: Connection,
        readonly id: string,
    ) {
        const language = HA.config?.language
        this.dict = language ? (this.constructor as typeof HADevice).translations[language] : undefined
        if (this.dict) this.reverseDict = new Map(Object.entries(this.dict).map(([en, local]) => [local, en]))
    }

    private translate(value: string) {
        return this.dict?.[value] ?? value
    }

    setConfig(config: DeviceDiscovery) {
        this.config = this.dict ? this.translateConfig(config) : config
        this.publishConfig()
    }

    // The entity ids stay those of the English names, so that switching the language later, or setting
    // it on a new installation, does not rename them. Home Assistant only applies default_entity_id when
    // it first creates an entity.
    private translateConfig(config: DeviceDiscovery): DeviceDiscovery {
        const deviceName = config.device.name
        const components = Object.fromEntries(
            Object.entries(config.components).map(([key, component]) => {
                const c = { ...component } as typeof component & { options?: string[] }
                if (deviceName && c.default_entity_id === undefined && typeof c.name === 'string')
                    c.default_entity_id = `${c.platform}.${slug(c.name ? `${deviceName} ${c.name}` : deviceName)}`
                if (c.name) c.name = this.translate(c.name)
                if (Array.isArray(c.options)) c.options = c.options.map((o) => this.translate(o))
                return [key, c]
            }),
        )
        const device = { ...config.device, ...(deviceName ? { name: this.translate(deviceName) } : {}) }
        return { ...config, device, components }
    }

    // Commands from Home Assistant come back in English before they reach `setProperty`.
    receiveProperty(prop: string, mqttValue: string) {
        this.setProperty(prop, this.reverseDict?.get(mqttValue) ?? mqttValue)
    }

    // `replaced`: the appliance reconnected and a new instance takes over the same id. Going offline
    // here would only flash every entity Unavailable in HA for a few milliseconds.
    drop(replaced = false) {
        if (!replaced) this.HA.publishProperty(this.id, 'availability', 'offline')
    }

    // Called before start() when this instance replaces `previous` after a reconnect, to carry over
    // state that only lives in rethink (choices made in HA but not sent yet).
    takeOver(previous: HADevice) {}

    start() {}

    // HA-side
    publishConfig() {
        if (this.config) {
            this.HA.publishProperty(this.id, 'availability', 'online')
            this.HA.publishConfig(this.id, this.config)
        }
    }

    setProperty(prop: string, mqttValue: string) {
        throw new Error('To be overriden')
    }

    publishCache = new Map<string, string | number | undefined>()

    // This deduplicates published values via `publishCache`. Callers can bypass it by calling
    // `this.HA.publishProperty` directly
    publishProperty(prop: string, value: string | number | undefined) {
        // has() first: an undefined value on a never-published property must still go out
        if (this.publishCache.has(prop) && this.publishCache.get(prop) === value) return

        this.publishCache.set(prop, value)
        this.HA.publishProperty(this.id, prop, typeof value === 'string' ? this.translate(value) : value)
    }
}
