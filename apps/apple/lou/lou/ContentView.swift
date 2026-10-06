//
//  ContentView.swift
//  lou
//
//  Created by Elijah Bantugan on 10/6/26.
//

import SwiftUI
import SwiftData

struct ContentView: View {
    @Environment(\.modelContext) private var modelContext
    @Query private var items: [Item]
    @State private var selectedItem: Item?

    var body: some View {
        NavigationViewWrapper {
            List(selection: $selectedItem) {
                ForEach(items) { item in
                    NavigationLink(value: item) {
                        Text(item.timestamp, format: Date.FormatStyle(date: .numeric, time: .standard))
                    }
                }
                .onDelete(perform: deleteItems)
            }
#if os(macOS)
            .navigationSplitViewColumnWidth(min: 180, ideal: 200)
#endif
            .navigationDestination(for: Item.self) { item in
                ItemDetailView(item: item)
            }
            .toolbar {
#if os(iOS)
                ToolbarItem(placement: .navigationBarTrailing) {
                    EditButton()
                }
#endif
                ToolbarItem {
                    Button(action: addItem) {
                        Label("Add Item", systemImage: "plus")
                    }
                }
            }
        } detail: {
            if let selectedItem {
                ItemDetailView(item: selectedItem)
            } else {
                Text("Select an item")
            }
        }
    }

    private func addItem() {
        withAnimation {
            let newItem = Item(timestamp: Date())
            modelContext.insert(newItem)
        }
    }

    private func deleteItems(offsets: IndexSet) {
        withAnimation {
            for index in offsets {
                let item = items[index]
                if selectedItem == item {
                    selectedItem = nil
                }
                modelContext.delete(item)
            }
        }
    }
}

private struct ItemDetailView: View {
    let item: Item

    var body: some View {
        Text("Item at \(item.timestamp, format: Date.FormatStyle(date: .numeric, time: .standard))")
    }
}

#Preview {
    ContentView()
        .modelContainer(for: Item.self, inMemory: true)
}
