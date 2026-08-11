let deferredInstallPrompt = null
const isIos = /iphone|ipad|ipod/i.test(window.navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const isStandalone = window.matchMedia('(display-mode: standalone)').matches
  || window.navigator.standalone === true

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault()
  deferredInstallPrompt = event
  const installButton = document.getElementById('install-app-btn')
  if (installButton && !isStandalone) installButton.classList.remove('hidden')
})

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null
  document.getElementById('install-app-btn')?.classList.add('hidden')
})

window.addEventListener('load', () => {
  if ('serviceWorker' in navigator) {
    const hadController = Boolean(navigator.serviceWorker.controller)
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !window.__zkSwRefreshing) {
        window.__zkSwRefreshing = true
        window.location.reload()
      }
    })
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then((registration) => registration.update())
      .catch((error) => console.error('Service worker registration failed:', error))
  }

  const installButton = document.getElementById('install-app-btn')
  const installModal = document.getElementById('install-help-modal')
  const closeInstallModal = document.getElementById('install-help-close')
  let installModalPreviousFocus = null

  const closeInstallHelp = () => {
    installModal?.classList.add('hidden')
    installModalPreviousFocus?.focus()
    installModalPreviousFocus = null
  }

  if (installButton && !isStandalone && (isIos || deferredInstallPrompt)) {
    installButton.classList.remove('hidden')
  }

  installButton?.addEventListener('click', async () => {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt()
      await deferredInstallPrompt.userChoice
      deferredInstallPrompt = null
      installButton.classList.add('hidden')
      return
    }
    installModalPreviousFocus = document.activeElement
    installModal?.classList.remove('hidden')
    closeInstallModal?.focus()
  })

  closeInstallModal?.addEventListener('click', closeInstallHelp)
  installModal?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeInstallHelp()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = [...installModal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  })
  installModal?.addEventListener('click', (event) => {
    if (event.target === installModal) closeInstallHelp()
  })
})
