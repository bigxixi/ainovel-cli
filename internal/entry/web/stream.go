package web

import (
	"sync"

	"github.com/voocel/ainovel-cli/internal/host"
)

// hubMessage 是 hub 广播给订阅者的一条消息。
// kind：event / delta / clear / done 为主流，import / sim 为导入、仿写等附加流。
type hubMessage struct {
	kind    string // "event" / "delta" / "clear" / "done" / "import" / "sim"
	event   host.Event
	delta   string
	payload any // 附加流（import/sim/cocreate）的原始事件
}

// StreamHub 把一本书的 Events()/Stream()/Done() 三通道广播给所有 SSE 订阅者。
//
// 生命周期：书会话创建时 newStreamHub(eng) 并启动 Run() 消费 goroutine；
// 该 goroutine 是宿主三通道的唯一消费者（通道必须单消费者，否则事件丢失/缓冲挤掉）。
// host.Close() 关闭三通道后 Run 广播 done 并退出，hub 置为 closed，
// 所有订阅者输出通道被关闭，SSE handler 感知后断开。
//
// 慢消费者策略：订阅通道缓冲满时直接断开该订阅者（SSE 重连后由 ReplayQueue 补齐缺口）。
type StreamHub struct {
	eng    *host.Host
	mu     sync.Mutex
	subs   map[chan hubMessage]struct{}
	closed bool
}

// newStreamHub 构造 hub，绑定宿主引擎。
func newStreamHub(eng *host.Host) *StreamHub {
	return &StreamHub{eng: eng, subs: make(map[chan hubMessage]struct{})}
}

// Run 启动广播循环，把宿主事件通道转发给所有订阅者。
// 阻塞直到 host 关闭（done 通道关闭）或三通道全部关闭。
func (h *StreamHub) Run() {
	events := h.eng.Events()
	stream := h.eng.Stream()
	done := h.eng.Done()

	for {
		select {
		case ev, ok := <-events:
			if !ok {
				events = nil
			} else {
				h.broadcast(hubMessage{kind: "event", event: ev})
			}
		case d, ok := <-stream:
			if !ok {
				stream = nil
			} else if d == host.StreamClearSentinel {
				h.broadcast(hubMessage{kind: "clear"})
			} else {
				h.broadcast(hubMessage{kind: "delta", delta: d})
			}
		case _, ok := <-done:
			if !ok {
				// host 已 Close：通知订阅者后退出。
				h.broadcast(hubMessage{kind: "done"})
				h.Close()
				return
			}
			// 单次引擎 run 结束（暂停/完本/出错），继续等待后续信号。
			h.broadcast(hubMessage{kind: "done"})
		}

		if events == nil && stream == nil {
			h.broadcast(hubMessage{kind: "done"})
			h.Close()
			return
		}
	}
}

// Subscribe 注册一个订阅者，返回其输出通道（调用方只读使用）。
// hub 已关闭时返回立即关闭的通道（调用方按断开处理）。
func (h *StreamHub) Subscribe() chan hubMessage {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		ch := make(chan hubMessage)
		close(ch)
		return ch
	}
	ch := make(chan hubMessage, 256)
	h.subs[ch] = struct{}{}
	return ch
}

// Unsubscribe 注销订阅者并关闭其输出通道。幂等。
func (h *StreamHub) Unsubscribe(ch chan hubMessage) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.subs[ch]; ok {
		delete(h.subs, ch)
		close(ch)
	}
}

// Publish 从任意 goroutine 向所有订阅者广播一条消息（导入/仿写/共创等附加流使用）。
// 与 Run 消费的主事件流互斥保护，可安全并发调用。
func (h *StreamHub) Publish(m hubMessage) {
	h.broadcast(m)
}

// broadcast 向所有订阅者发送消息；慢消费者断开（通道关闭、移出集合）。
func (h *StreamHub) broadcast(m hubMessage) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return
	}
	for ch := range h.subs {
		select {
		case ch <- m:
		default:
			// 订阅者消费太慢：断开，靠 SSE 重连 + ReplayQueue 补齐。
			close(ch)
			delete(h.subs, ch)
		}
	}
}

// Close 关闭 hub：断开所有订阅者并标记 closed。幂等。
func (h *StreamHub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return
	}
	h.closed = true
	for ch := range h.subs {
		close(ch)
	}
	h.subs = nil
}
