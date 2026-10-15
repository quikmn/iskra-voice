import { describe, expect, it } from 'vitest'
import type { FileInfo } from '../core/protocol'
import { cleanImages, keepImages, serverImageUrl, useServerImages } from './serverImages'

const file = (url: string, id = 'abc'): FileInfo => ({ id, name: 'icon.webp', size: 1000, type: 'image/webp', width: 512, height: 512, url })

describe('server images', () => {
  it('keeps each server its own icon and banner, and replaces them as the server says', () => {
    keepImages('s1', { icon: file('/files/abc/icon.webp'), banner: null })
    keepImages('s2', { icon: null, banner: file('/files/def/banner.webp', 'def') })
    expect(useServerImages.getState().images.s1.icon?.id).toBe('abc')
    expect(useServerImages.getState().images.s1.banner).toBeNull()
    expect(useServerImages.getState().images.s2.banner?.id).toBe('def')

    keepImages('s1', { icon: null, banner: null }) // removed by an admin
    expect(useServerImages.getState().images.s1.icon).toBeNull()
    expect(useServerImages.getState().images.s2.banner?.id).toBe('def')
  })

  it('only takes pictures that live on the server', () => {
    expect(cleanImages({ icon: file('https://elsewhere.example/x.png'), banner: file('javascript:alert(1)') })).toEqual({ icon: null, banner: null })
    expect(cleanImages(undefined)).toEqual({ icon: null, banner: null })
    expect(cleanImages({ icon: file('/files/abc/icon.webp') }).icon?.url).toBe('/files/abc/icon.webp')
  })

  it('builds the address on the server', () => {
    expect(serverImageUrl('https://chat.example.com:47070/', file('/files/abc/icon.webp'))).toBe('https://chat.example.com:47070/files/abc/icon.webp')
    expect(serverImageUrl('https://chat.example.com', null)).toBeNull()
    expect(serverImageUrl(undefined, file('/files/abc/icon.webp'))).toBeNull()
  })
})
