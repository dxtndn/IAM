import { Capacitor } from '@capacitor/core'
import { CapacitorSQLite, SQLiteConnection, SQLiteDBConnection } from '@capacitor-community/sqlite'
import { initialSchema } from './migrations/001_initial'

const STORAGE_KEY = 'iam_data'
const DB_NAME = 'iam_db'

let isInitialized = false
let isNative = false
let sqliteConnection: SQLiteConnection | null = null
let db_native: SQLiteDBConnection | null = null

// In-memory storage for web fallback
interface StorageData {
  habits: any[]
  habit_groups: any[]
  habit_completions: any[]
  checklists: any[]
  checklist_items: any[]
  foods: any[]
  meal_ideas: any[]
  workout_programs: any[]
  workout_days: any[]
  exercises: any[]
  workout_completions: any[]
  settings: any
  _counters: { [table: string]: number }
}

function getDefaultStorage(): StorageData {
  return {
    habits: [],
    habit_groups: [],
    habit_completions: [],
    checklists: [],
    checklist_items: [],
    foods: [],
    meal_ideas: [],
    workout_programs: [],
    workout_days: [],
    exercises: [],
    workout_completions: [],
    settings: { id: 1, theme: 'system', user_name: '', sport_focus: 'general', age_group: 'adult' },
    _counters: {}
  }
}

function loadStorage(): StorageData {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      return { ...getDefaultStorage(), ...JSON.parse(stored) }
    }
  } catch (e) {
    console.error('Failed to load storage:', e)
  }
  return getDefaultStorage()
}

function saveStorage(data: StorageData): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch (e) {
    console.error('Failed to save storage:', e)
  }
}

function getNextId(table: string): number {
  const data = loadStorage()
  const current = data._counters[table] || 0
  data._counters[table] = current + 1
  saveStorage(data)
  return current + 1
}

// Table name mapping for SQL parsing
const tableMap: { [key: string]: keyof Omit<StorageData, '_counters' | 'settings'> } = {
  habits: 'habits',
  habit_groups: 'habit_groups',
  habit_completions: 'habit_completions',
  checklists: 'checklists',
  checklist_items: 'checklist_items',
  foods: 'foods',
  meal_ideas: 'meal_ideas',
  workout_programs: 'workout_programs',
  workout_days: 'workout_days',
  exercises: 'exercises',
  workout_completions: 'workout_completions'
}

// Simple SQL parser for localStorage fallback
function parseSimpleQuery(sql: string, _values: any[] = []): { table: string; type: 'select' | 'insert' | 'update' | 'delete'; data?: any } {
  const normalizedSql = sql.replace(/\s+/g, ' ').trim().toLowerCase()

  if (normalizedSql.startsWith('select')) {
    const fromMatch = sql.match(/from\s+(\w+)/i)
    return { table: fromMatch?.[1] || '', type: 'select' }
  }
  if (normalizedSql.startsWith('insert')) {
    const intoMatch = sql.match(/into\s+(\w+)/i)
    return { table: intoMatch?.[1] || '', type: 'insert' }
  }
  if (normalizedSql.startsWith('update')) {
    const tableMatch = sql.match(/update\s+(\w+)/i)
    return { table: tableMatch?.[1] || '', type: 'update' }
  }
  if (normalizedSql.startsWith('delete')) {
    const fromMatch = sql.match(/from\s+(\w+)/i)
    return { table: fromMatch?.[1] || '', type: 'delete' }
  }

  return { table: '', type: 'select' }
}

// Database interface for both native and web
export const db = {
  async query<T>(sql: string, values: any[] = []): Promise<T[]> {
    if (isNative && db_native) {
      try {
        const result = await db_native.query(sql, values)
        return (result.values || []) as T[]
      } catch (e) {
        console.error('Native SQLite query error:', e, sql, values)
        return []
      }
    }

    // Web localStorage fallback
    const parsed = parseSimpleQuery(sql, values)
    const data = loadStorage()
    const tableName = tableMap[parsed.table]

    if (!tableName) {
      // Handle special queries
      if (sql.includes('MAX(sort_order)')) {
        const tableInSql = sql.match(/from\s+(\w+)/i)?.[1]
        const items = data[tableMap[tableInSql || ''] || 'habits'] as any[] || []
        const maxOrder = items.reduce((max, item) => Math.max(max, item.sort_order || 0), -1)
        return [{ maxOrder } as T]
      }
      if (sql.includes('COUNT(*)')) {
        // Handle count queries for completions
        if (sql.includes('habit_completions')) {
          const habitId = values[0]
          const date = values[1]
          const count = data.habit_completions.filter(
            (c: any) => c.habit_id === habitId && c.completed_date === date
          ).length
          return [{ count } as T]
        }
      }
      return []
    }

    let items = [...(data[tableName] as any[])]

    // Apply WHERE clause filtering
    if (sql.includes('WHERE')) {
      const whereMatch = sql.match(/where\s+(.+?)(?:order|group|limit|$)/i)
      if (whereMatch) {
        const conditions = whereMatch[1]
        let valueIndex = 0

        items = items.filter((item: any) => {
          // Handle various WHERE conditions
          if (conditions.includes('is_active = 1') && item.is_active !== 1 && item.isActive !== 1) {
            return false
          }
          if (conditions.includes('id = ?')) {
            return item.id === values[valueIndex]
          }
          if (conditions.includes('habit_id = ?') && conditions.includes('completed_date = ?')) {
            return item.habit_id === values[0] && item.completed_date === values[1]
          }
          if (conditions.includes('completed_date = ?')) {
            return item.completed_date === values[valueIndex]
          }
          if (conditions.includes('completed_date >= ?') && conditions.includes('completed_date <= ?')) {
            return item.completed_date >= values[0] && item.completed_date <= values[1]
          }
          return true
        })
      }
    }

    // Apply ORDER BY
    if (sql.includes('ORDER BY')) {
      const orderMatch = sql.match(/order\s+by\s+(\w+)/i)
      if (orderMatch) {
        const field = orderMatch[1]
        items.sort((a: any, b: any) => (a[field] || 0) - (b[field] || 0))
      }
    }

    // Map column aliases
    return items.map((item: any) => {
      const mapped: any = { ...item }
      // Handle common snake_case to camelCase mappings
      if (item.group_id !== undefined) mapped.groupId = item.group_id
      if (item.sort_order !== undefined) mapped.sortOrder = item.sort_order
      if (item.is_active !== undefined) mapped.isActive = item.is_active
      if (item.created_at !== undefined) mapped.createdAt = item.created_at
      if (item.updated_at !== undefined) mapped.updatedAt = item.updated_at
      if (item.habit_id !== undefined) mapped.habitId = item.habit_id
      if (item.completed_date !== undefined) mapped.completedDate = item.completed_date
      if (item.checklist_id !== undefined) mapped.checklistId = item.checklist_id
      if (item.is_completed !== undefined) mapped.isCompleted = item.is_completed
      if (item.is_template !== undefined) mapped.isTemplate = item.is_template
      if (item.meal_type !== undefined) mapped.mealType = item.meal_type
      if (item.prep_time !== undefined) mapped.prepTime = item.prep_time
      if (item.is_favorite !== undefined) mapped.isFavorite = item.is_favorite
      if (item.serving_size !== undefined) mapped.servingSize = item.serving_size
      if (item.is_custom !== undefined) mapped.isCustom = item.is_custom
      return mapped as T
    })
  },

  async run(sql: string, values: any[] = []): Promise<{ changes: number; lastInsertId: number }> {
    if (isNative && db_native) {
      try {
        const result = await db_native.run(sql, values)
        return {
          changes: result.changes?.changes || 0,
          lastInsertId: result.changes?.lastId || 0
        }
      } catch (e) {
        console.error('Native SQLite run error:', e, sql, values)
        return { changes: 0, lastInsertId: 0 }
      }
    }

    const parsed = parseSimpleQuery(sql, values)
    const data = loadStorage()
    const tableName = tableMap[parsed.table]

    if (parsed.type === 'insert' && tableName) {
      const id = getNextId(parsed.table)
      const now = new Date().toISOString()

      // Parse INSERT columns and values
      const colMatch = sql.match(/\(([^)]+)\)\s*VALUES/i)
      const cols = colMatch ? colMatch[1].split(',').map(c => c.trim()) : []

      const newItem: any = { id, created_at: now, updated_at: now }
      cols.forEach((col, idx) => {
        if (values[idx] !== undefined) {
          newItem[col] = values[idx]
        }
      })

      ;(data[tableName] as any[]).push(newItem)
      saveStorage(data)
      return { changes: 1, lastInsertId: id }
    }

    if (parsed.type === 'update' && tableName) {
      let changes = 0
      const items = data[tableName] as any[]

      // Simple update parsing
      const setMatch = sql.match(/set\s+(.+?)\s+where/i)
      const whereMatch = sql.match(/where\s+(.+)/i)

      if (setMatch && whereMatch) {
        const lastValue = values[values.length - 1] // Usually the ID
        items.forEach((item: any, idx: number) => {
          if (item.id === lastValue) {
            // Apply updates
            let valueIdx = 0
            const setParts = setMatch[1].split(',')
            setParts.forEach(part => {
              const [col] = part.split('=').map(s => s.trim())
              if (col && !col.includes('datetime')) {
                items[idx][col] = values[valueIdx++]
              }
            })
            items[idx].updated_at = new Date().toISOString()
            changes++
          }
        })
      }

      saveStorage(data)
      return { changes, lastInsertId: 0 }
    }

    if (parsed.type === 'delete' && tableName) {
      const items = data[tableName] as any[]
      const originalLength = items.length

      // Filter out deleted items
      if (sql.includes('habit_id = ?') && sql.includes('completed_date = ?')) {
        data[tableName] = items.filter(
          (item: any) => !(item.habit_id === values[0] && item.completed_date === values[1])
        ) as any
      } else if (sql.includes('id = ?')) {
        data[tableName] = items.filter((item: any) => item.id !== values[0]) as any
      }

      saveStorage(data)
      return { changes: originalLength - (data[tableName] as any[]).length, lastInsertId: 0 }
    }

    return { changes: 0, lastInsertId: 0 }
  }
}

/**
 * Initialize the database connection
 */
export async function initDatabase(): Promise<void> {
  if (isInitialized) return

  const platform = Capacitor.getPlatform()
  isNative = platform === 'ios' || platform === 'android'

  if (!isNative) {
    console.log('Running on web platform - using localStorage fallback')
    loadStorage()
    isInitialized = true
    return
  }

  try {
    // Initialize SQLite connection
    sqliteConnection = new SQLiteConnection(CapacitorSQLite)

    // Check connection consistency (required for iOS)
    const retCC = await sqliteConnection.checkConnectionsConsistency()
    const isConn = (await sqliteConnection.isConnection(DB_NAME, false)).result

    if (retCC.result && isConn) {
      db_native = await sqliteConnection.retrieveConnection(DB_NAME, false)
    } else {
      db_native = await sqliteConnection.createConnection(
        DB_NAME,
        false,
        'no-encryption',
        1,
        false
      )
    }

    await db_native.open()

    // Run migrations - split by semicolons and execute each statement
    const statements = initialSchema
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0)

    for (const statement of statements) {
      await db_native.execute(statement + ';')
    }

    isInitialized = true
    console.log('Native SQLite database initialized successfully')
  } catch (e) {
    console.error('Failed to initialize native SQLite:', e)
    throw e
  }
}

/**
 * Check if running on native platform with SQLite support
 */
export function isNativePlatform(): boolean {
  return isNative
}

/**
 * Clear all data (for settings reset)
 */
export function clearAllData(): void {
  localStorage.removeItem(STORAGE_KEY)
}

/**
 * Export all data as JSON
 */
export function exportData(): string {
  return localStorage.getItem(STORAGE_KEY) || JSON.stringify(getDefaultStorage())
}

/**
 * Import data from JSON
 */
export function importData(jsonData: string): boolean {
  try {
    const data = JSON.parse(jsonData)
    saveStorage(data)
    return true
  } catch (e) {
    console.error('Failed to import data:', e)
    return false
  }
}
