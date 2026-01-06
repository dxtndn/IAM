<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { RefreshCw } from 'lucide-vue-next'
import { useHaptics } from '@/composables/useHaptics'

const props = defineProps<{
  loading?: boolean
}>()

const emit = defineEmits<{
  refresh: []
}>()

const { mediumImpact } = useHaptics()

const containerRef = ref<HTMLElement | null>(null)
const pullDistance = ref(0)
const isPulling = ref(false)
const isRefreshing = ref(false)

const PULL_THRESHOLD = 80
const MAX_PULL = 120

let startY = 0
let scrollContainer: HTMLElement | null = null

// Find the actual scroll container (parent with overflow-y: auto/scroll)
function findScrollContainer(el: HTMLElement | null): HTMLElement | null {
  if (!el) return null
  let parent = el.parentElement
  while (parent) {
    const style = getComputedStyle(parent)
    if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
      return parent
    }
    parent = parent.parentElement
  }
  return null
}

function getScrollTop(): number {
  if (scrollContainer) {
    return scrollContainer.scrollTop
  }
  return 0
}

function handleTouchStart(e: TouchEvent) {
  if (isRefreshing.value || props.loading) return

  const currentScrollTop = getScrollTop()
  if (currentScrollTop > 0) return

  startY = e.touches[0].clientY
  isPulling.value = true
}

function handleTouchMove(e: TouchEvent) {
  if (!isPulling.value || isRefreshing.value || props.loading) return

  const currentScrollTop = getScrollTop()
  if (currentScrollTop > 0) {
    isPulling.value = false
    pullDistance.value = 0
    return
  }

  const currentY = e.touches[0].clientY
  const diff = currentY - startY

  if (diff > 0) {
    e.preventDefault()
    // Apply resistance
    pullDistance.value = Math.min(diff * 0.5, MAX_PULL)
  } else {
    // User is scrolling down, cancel pull-to-refresh
    isPulling.value = false
    pullDistance.value = 0
  }
}

async function handleTouchEnd() {
  if (!isPulling.value || isRefreshing.value || props.loading) return

  isPulling.value = false

  if (pullDistance.value >= PULL_THRESHOLD) {
    isRefreshing.value = true
    await mediumImpact()
    emit('refresh')
  }

  pullDistance.value = 0
}

onMounted(() => {
  const container = containerRef.value
  if (container) {
    scrollContainer = findScrollContainer(container)
    container.addEventListener('touchstart', handleTouchStart, { passive: true })
    container.addEventListener('touchmove', handleTouchMove, { passive: false })
    container.addEventListener('touchend', handleTouchEnd, { passive: true })
  }
})

onUnmounted(() => {
  const container = containerRef.value
  if (container) {
    container.removeEventListener('touchstart', handleTouchStart)
    container.removeEventListener('touchmove', handleTouchMove)
    container.removeEventListener('touchend', handleTouchEnd)
  }
  scrollContainer = null
})

// Reset when loading finishes
defineExpose({
  finishRefresh: () => {
    isRefreshing.value = false
  }
})
</script>

<template>
  <div ref="containerRef" class="pull-to-refresh-container">
    <!-- Pull indicator -->
    <div
      class="pull-indicator"
      :class="{ visible: pullDistance > 0 || isRefreshing || loading }"
      :style="{
        transform: `translateY(${Math.max(pullDistance - 40, isRefreshing || loading ? 20 : -40)}px)`,
        opacity: Math.min(pullDistance / PULL_THRESHOLD, 1)
      }"
    >
      <RefreshCw
        class="refresh-icon"
        :class="{
          spinning: isRefreshing || loading,
          ready: pullDistance >= PULL_THRESHOLD && !isRefreshing && !loading
        }"
        :size="24"
      />
    </div>

    <!-- Content -->
    <div
      class="pull-content"
      :style="{
        transform: `translateY(${pullDistance}px)`,
        transition: isPulling ? 'none' : 'transform 0.3s ease'
      }"
    >
      <slot />
    </div>
  </div>
</template>

<style scoped>
.pull-to-refresh-container {
  @apply relative h-full;
}

.pull-indicator {
  @apply absolute top-0 left-1/2 -translate-x-1/2 z-10;
  @apply flex items-center justify-center;
  @apply w-10 h-10 rounded-full;
  @apply bg-surface-light dark:bg-surface-dark;
  @apply shadow-md;
  opacity: 0;
  transition: transform 0.3s ease, opacity 0.3s ease;
}

.pull-indicator.visible {
  opacity: 1;
}

.refresh-icon {
  @apply text-primary;
  transition: transform 0.3s ease;
}

.refresh-icon.ready {
  transform: rotate(180deg);
}

.refresh-icon.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.pull-content {
  @apply min-h-full;
}
</style>
