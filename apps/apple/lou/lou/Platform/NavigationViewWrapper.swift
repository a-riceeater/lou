import SwiftUI

// Keep native navigation behavior separate from the shared item list.
struct NavigationViewWrapper<Content: View, Detail: View>: View {
    @ViewBuilder let content: () -> Content
    @ViewBuilder let detail: () -> Detail

    var body: some View {
#if os(macOS)
        NavigationSplitView {
            content()
        } detail: {
            detail()
        }
#elseif os(iOS)
        NavigationStack {
            content()
        }
#endif
    }
}

