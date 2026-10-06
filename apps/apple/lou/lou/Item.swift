//
//  Item.swift
//  lou
//
//  Created by Elijah Bantugan on 10/6/26.
//

import Foundation
import SwiftData

@Model
final class Item {
    var timestamp: Date
    
    init(timestamp: Date) {
        self.timestamp = timestamp
    }
}
