import { describe, expect, it } from 'vitest'
import { cleanDeviceLabel, deviceChoices, listedDevices, outputSource, parseRoutes, routeChoices, type DeviceLike } from './deviceChoices'

const text = { default: 'Default', numbered: (n: number) => `Microphone ${n}` }
const mic = (deviceId: string, label = ''): DeviceLike => ({ kind: 'audioinput', deviceId, label })

describe('the devices a call lets you choose', () => {
  it('lists the real devices of one kind, with Default first and the chosen one marked', () => {
    const devices = [
      mic('default', 'Default - Headset'), mic('communications', 'Communications - Headset'), mic('a', 'Headset'), mic('b', 'Webcam C920 (046d:082d)'),
      { kind: 'audiooutput', deviceId: 'x', label: 'Speakers' },
    ]
    expect(deviceChoices('audioinput', devices, 'b', text)).toEqual([
      { id: '', label: 'Default', current: false },
      { id: 'a', label: 'Headset', current: false },
      { id: 'b', label: 'Webcam C920', current: true },
    ])
    expect(deviceChoices('audiooutput', devices, '', text).map((c) => [c.label, c.current])).toEqual([['Default', true], ['Speakers', false]])
  })

  it('a chosen device that is gone shows as the default', () => {
    const choices = deviceChoices('audioinput', [mic('a', 'Headset')], 'a-microphone-that-is-gone', text)
    expect(choices.map((c) => c.current)).toEqual([true, false])
  })

  it('numbers devices without a name, and tells two with the same name apart', () => {
    expect(deviceChoices('audioinput', [mic('a'), mic('b')], '', text).map((c) => c.label)).toEqual(['Default', 'Microphone 1', 'Microphone 2'])
    expect(deviceChoices('audioinput', [mic('a', 'USB Audio'), mic('b', 'USB Audio')], '', text).map((c) => c.label)).toEqual(['Default', 'USB Audio', 'USB Audio (2)'])
  })

  it('is empty when the browser lists nothing to choose from', () => {
    // Before permission the browser lists one entry per kind without an id.
    expect(deviceChoices('audioinput', [mic('')], '', text)).toEqual([])
    expect(deviceChoices('audioinput', [mic('default', 'Default')], '', text)).toEqual([])
    expect(listedDevices('audioinput', [mic('a'), mic('a')])).toHaveLength(1)
  })

  it('drops the USB numbers Chrome adds to a name, nothing else', () => {
    expect(cleanDeviceLabel('Microphone (HD Pro Webcam C920) (046d:082d)')).toBe('Microphone (HD Pro Webcam C920)')
    expect(cleanDeviceLabel('Speakers (Realtek(R) Audio)')).toBe('Speakers (Realtek(R) Audio)')
  })
})

describe('where a call plays in the Android app', () => {
  const kindText = (kind: string) => ({ speaker: 'Speaker', earpiece: 'Phone', wired: 'Wired headset', usb: 'USB headset', bluetooth: 'Bluetooth headset', hearingAid: 'Hearing aid' })[kind]!

  it('reads the plugin answer, leaving out what is malformed', () => {
    const parsed = parseRoutes({
      routes: [
        { id: 7, kind: 'bluetooth', name: ' WH-1000XM4 ' }, { id: 2, kind: 'earpiece', name: 'ONEPLUS' }, { id: 3, kind: 'speaker', name: 'ONEPLUS' },
        { id: 3, kind: 'speaker', name: 'again' }, { id: 'x', kind: 'speaker' }, { id: 9, kind: 'hdmi' }, null,
      ],
      current: 7,
    })
    expect(parsed.routes.map((r) => [r.id, r.kind, r.name])).toEqual([[3, 'speaker', 'ONEPLUS'], [2, 'earpiece', 'ONEPLUS'], [7, 'bluetooth', 'WH-1000XM4']])
    expect(parsed.current).toBe(7)
    expect(parseRoutes({ routes: [{ id: 1, kind: 'speaker' }], current: 5 })).toEqual({ routes: [{ id: 1, kind: 'speaker', name: '' }], current: null })
    expect(parseRoutes(undefined)).toEqual({ routes: [], current: null })
  })

  it('names the phone itself by what it is and a Bluetooth headset by its own name', () => {
    const { routes, current } = parseRoutes({
      routes: [{ id: 3, kind: 'speaker', name: 'ONEPLUS' }, { id: 2, kind: 'earpiece', name: 'ONEPLUS' }, { id: 5, kind: 'wired', name: 'ONEPLUS' }, { id: 7, kind: 'bluetooth', name: 'WH-1000XM4' }, { id: 8, kind: 'bluetooth', name: '' }],
      current: 2,
    })
    expect(routeChoices(routes, current, kindText)).toEqual([
      { id: '3', label: 'Speaker', current: false },
      { id: '2', label: 'Phone', current: true },
      { id: '5', label: 'Wired headset', current: false },
      { id: '7', label: 'WH-1000XM4', current: false },
      { id: '8', label: 'Bluetooth headset', current: false },
    ])
  })

  it('the output list: the phone routes on Android, the browser where it can choose, none on the iPhone or Safari', () => {
    expect(outputSource({ platform: 'android', nativeRoutes: true, sinkId: true })).toBe('routes')
    expect(outputSource({ platform: 'android', nativeRoutes: false, sinkId: true })).toBe('none')
    expect(outputSource({ platform: 'ios', nativeRoutes: false, sinkId: false })).toBe('none')
    expect(outputSource({ platform: null, nativeRoutes: false, sinkId: true })).toBe('browser')
    expect(outputSource({ platform: null, nativeRoutes: false, sinkId: false })).toBe('none')
  })
})
