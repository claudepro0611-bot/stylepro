export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      campaigns: {
        Row: {
          company_id: string
          created_at: string
          discount: number
          end_date: string | null
          id: string
          name: string
          start_date: string | null
          status: string
          type: string
          updated_at: string
          usage_count: number
          usage_limit: number
        }
        Insert: {
          company_id: string
          created_at?: string
          discount?: number
          end_date?: string | null
          id?: string
          name: string
          start_date?: string | null
          status?: string
          type: string
          updated_at?: string
          usage_count?: number
          usage_limit?: number
        }
        Update: {
          company_id?: string
          created_at?: string
          discount?: number
          end_date?: string | null
          id?: string
          name?: string
          start_date?: string | null
          status?: string
          type?: string
          updated_at?: string
          usage_count?: number
          usage_limit?: number
        }
        Relationships: [
          {
            foreignKeyName: "campaigns_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      companies: {
        Row: {
          address: string | null
          balance: number | null
          billing_status: string | null
          created_at: string
          currency: string
          daily_penalty: number | null
          grace_period_start: string | null
          has_contract: boolean | null
          id: string
          last_payment_date: string | null
          max_grace_days: number | null
          monthly_fee: number | null
          name: string
          next_payment_date: string | null
          payment_due_date: string | null
          penalty_days: number | null
          phone: string | null
          slug: string | null
          status: string
          total_penalty: number | null
          updated_at: string
          user_limit: number
          warehouse_limit: number
        }
        Insert: {
          address?: string | null
          balance?: number | null
          billing_status?: string | null
          created_at?: string
          currency?: string
          daily_penalty?: number | null
          grace_period_start?: string | null
          has_contract?: boolean | null
          id?: string
          last_payment_date?: string | null
          max_grace_days?: number | null
          monthly_fee?: number | null
          name: string
          next_payment_date?: string | null
          payment_due_date?: string | null
          penalty_days?: number | null
          phone?: string | null
          slug?: string | null
          status?: string
          total_penalty?: number | null
          updated_at?: string
          user_limit?: number
          warehouse_limit?: number
        }
        Update: {
          address?: string | null
          balance?: number | null
          billing_status?: string | null
          created_at?: string
          currency?: string
          daily_penalty?: number | null
          grace_period_start?: string | null
          has_contract?: boolean | null
          id?: string
          last_payment_date?: string | null
          max_grace_days?: number | null
          monthly_fee?: number | null
          name?: string
          next_payment_date?: string | null
          payment_due_date?: string | null
          penalty_days?: number | null
          phone?: string | null
          slug?: string | null
          status?: string
          total_penalty?: number | null
          updated_at?: string
          user_limit?: number
          warehouse_limit?: number
        }
        Relationships: []
      }
      company_features: {
        Row: {
          activated_at: string
          company_id: string
          expires_at: string | null
          feature_key: string
          id: string
          is_active: boolean
        }
        Insert: {
          activated_at?: string
          company_id: string
          expires_at?: string | null
          feature_key: string
          id?: string
          is_active?: boolean
        }
        Update: {
          activated_at?: string
          company_id?: string
          expires_at?: string | null
          feature_key?: string
          id?: string
          is_active?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "company_features_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_features_feature_key_fkey"
            columns: ["feature_key"]
            isOneToOne: false
            referencedRelation: "feature_definitions"
            referencedColumns: ["key"]
          },
        ]
      }
      company_settings: {
        Row: {
          company_id: string
          settings: Json
          updated_at: string | null
        }
        Insert: {
          company_id: string
          settings?: Json
          updated_at?: string | null
        }
        Update: {
          company_id?: string
          settings?: Json
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "company_settings_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: true
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      coupons: {
        Row: {
          code: string
          company_id: string
          created_at: string
          discount: number
          expiry_date: string | null
          id: string
          status: string
          updated_at: string
          usage_limit: number
          used_count: number
        }
        Insert: {
          code: string
          company_id: string
          created_at?: string
          discount?: number
          expiry_date?: string | null
          id?: string
          status?: string
          updated_at?: string
          usage_limit?: number
          used_count?: number
        }
        Update: {
          code?: string
          company_id?: string
          created_at?: string
          discount?: number
          expiry_date?: string | null
          id?: string
          status?: string
          updated_at?: string
          usage_limit?: number
          used_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "coupons_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          address: string | null
          company_id: string
          complaints: string[]
          created_at: string
          email: string | null
          full_name: string
          id: string
          last_purchase_date: string | null
          phone: string | null
          status: string
          total_purchases: number
          updated_at: string
          vip_discount_percent: number | null
          vip_since: string | null
        }
        Insert: {
          address?: string | null
          company_id: string
          complaints?: string[]
          created_at?: string
          email?: string | null
          full_name: string
          id?: string
          last_purchase_date?: string | null
          phone?: string | null
          status?: string
          total_purchases?: number
          updated_at?: string
          vip_discount_percent?: number | null
          vip_since?: string | null
        }
        Update: {
          address?: string | null
          company_id?: string
          complaints?: string[]
          created_at?: string
          email?: string | null
          full_name?: string
          id?: string
          last_purchase_date?: string | null
          phone?: string | null
          status?: string
          total_purchases?: number
          updated_at?: string
          vip_discount_percent?: number | null
          vip_since?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "customers_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      departments: {
        Row: {
          company_id: string
          created_at: string
          description: string | null
          id: string
          manager_id: string | null
          manager_name: string | null
          name: string
          status: string
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          description?: string | null
          id?: string
          manager_id?: string | null
          manager_name?: string | null
          name: string
          status?: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          description?: string | null
          id?: string
          manager_id?: string | null
          manager_name?: string | null
          name?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "departments_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      employees: {
        Row: {
          address: string | null
          birth_date: string | null
          company_id: string
          created_at: string
          department_id: string | null
          department_name: string | null
          first_name: string
          id: string
          last_name: string
          phone: string | null
          photo_url: string | null
          position_id: string | null
          position_name: string | null
          salary: number
          start_date: string
          status: string
          updated_at: string
        }
        Insert: {
          address?: string | null
          birth_date?: string | null
          company_id: string
          created_at?: string
          department_id?: string | null
          department_name?: string | null
          first_name: string
          id?: string
          last_name: string
          phone?: string | null
          photo_url?: string | null
          position_id?: string | null
          position_name?: string | null
          salary?: number
          start_date?: string
          status?: string
          updated_at?: string
        }
        Update: {
          address?: string | null
          birth_date?: string | null
          company_id?: string
          created_at?: string
          department_id?: string | null
          department_name?: string | null
          first_name?: string
          id?: string
          last_name?: string
          phone?: string | null
          photo_url?: string | null
          position_id?: string | null
          position_name?: string | null
          salary?: number
          start_date?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "employees_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_position_id_fkey"
            columns: ["position_id"]
            isOneToOne: false
            referencedRelation: "positions"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_categories: {
        Row: {
          color: string | null
          company_id: string
          created_at: string | null
          id: string
          name: string
        }
        Insert: {
          color?: string | null
          company_id: string
          created_at?: string | null
          id?: string
          name: string
        }
        Update: {
          color?: string | null
          company_id?: string
          created_at?: string | null
          id?: string
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "expense_categories_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      expenses: {
        Row: {
          amount: number
          category_id: string | null
          company_id: string
          created_at: string | null
          created_by: string | null
          date: string
          id: string
          note: string | null
          payment_method: string
        }
        Insert: {
          amount: number
          category_id?: string | null
          company_id: string
          created_at?: string | null
          created_by?: string | null
          date?: string
          id?: string
          note?: string | null
          payment_method?: string
        }
        Update: {
          amount?: number
          category_id?: string | null
          company_id?: string
          created_at?: string | null
          created_by?: string | null
          date?: string
          id?: string
          note?: string | null
          payment_method?: string
        }
        Relationships: [
          {
            foreignKeyName: "expenses_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "expense_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      feature_definitions: {
        Row: {
          created_at: string
          description: string | null
          is_core: boolean
          key: string
          name: string
          price_usd: number
        }
        Insert: {
          created_at?: string
          description?: string | null
          is_core?: boolean
          key: string
          name: string
          price_usd?: number
        }
        Update: {
          created_at?: string
          description?: string | null
          is_core?: boolean
          key?: string
          name?: string
          price_usd?: number
        }
        Relationships: []
      }
      loyalty_config: {
        Row: {
          ball_rate: number
          company_id: string
          created_at: string
          id: string
          is_active: boolean
          mode: string
          redeem_rate: number
          updated_at: string
        }
        Insert: {
          ball_rate: number
          company_id: string
          created_at?: string
          id?: string
          is_active?: boolean
          mode: string
          redeem_rate: number
          updated_at?: string
        }
        Update: {
          ball_rate?: number
          company_id?: string
          created_at?: string
          id?: string
          is_active?: boolean
          mode?: string
          redeem_rate?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "loyalty_config_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: true
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      loyalty_transactions: {
        Row: {
          amount: number
          company_id: string
          created_at: string
          customer_id: string
          id: string
          note: string | null
          transaction_id: string | null
          type: string
        }
        Insert: {
          amount: number
          company_id: string
          created_at?: string
          customer_id: string
          id?: string
          note?: string | null
          transaction_id?: string | null
          type: string
        }
        Update: {
          amount?: number
          company_id?: string
          created_at?: string
          customer_id?: string
          id?: string
          note?: string | null
          transaction_id?: string | null
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "loyalty_transactions_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_transactions_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_transactions_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: false
            referencedRelation: "transactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_transactions_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: false
            referencedRelation: "transactions_net"
            referencedColumns: ["id"]
          },
        ]
      }
      nasiya_transactions: {
        Row: {
          amount: number
          company_id: string
          created_at: string
          customer_id: string
          id: string
          note: string | null
          related_transaction_id: string | null
          type: string
        }
        Insert: {
          amount: number
          company_id: string
          created_at?: string
          customer_id: string
          id?: string
          note?: string | null
          related_transaction_id?: string | null
          type: string
        }
        Update: {
          amount?: number
          company_id?: string
          created_at?: string
          customer_id?: string
          id?: string
          note?: string | null
          related_transaction_id?: string | null
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "nasiya_transactions_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nasiya_transactions_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nasiya_transactions_related_transaction_id_fkey"
            columns: ["related_transaction_id"]
            isOneToOne: false
            referencedRelation: "transactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nasiya_transactions_related_transaction_id_fkey"
            columns: ["related_transaction_id"]
            isOneToOne: false
            referencedRelation: "transactions_net"
            referencedColumns: ["id"]
          },
        ]
      }
      position_history: {
        Row: {
          company_id: string
          created_at: string
          date: string
          department_name: string | null
          employee_id: string
          id: string
          note: string | null
          position_name: string | null
          salary: number
        }
        Insert: {
          company_id: string
          created_at?: string
          date?: string
          department_name?: string | null
          employee_id: string
          id?: string
          note?: string | null
          position_name?: string | null
          salary?: number
        }
        Update: {
          company_id?: string
          created_at?: string
          date?: string
          department_name?: string | null
          employee_id?: string
          id?: string
          note?: string | null
          position_name?: string | null
          salary?: number
        }
        Relationships: [
          {
            foreignKeyName: "position_history_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "position_history_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "position_history_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      positions: {
        Row: {
          company_id: string
          created_at: string
          department_id: string | null
          department_name: string | null
          description: string | null
          id: string
          name: string
          status: string
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          department_id?: string | null
          department_name?: string | null
          description?: string | null
          id?: string
          name: string
          status?: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          department_id?: string | null
          department_name?: string | null
          description?: string | null
          id?: string
          name?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "positions_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "positions_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
        ]
      }
      product_groups: {
        Row: {
          company_id: string
          created_at: string
          description: string | null
          id: string
          name: string
          size_type: string | null
          status: string
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          description?: string | null
          id?: string
          name: string
          size_type?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          size_type?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_groups_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      product_sizes: {
        Row: {
          barcode: string | null
          color: string
          company_id: string
          created_at: string | null
          id: string
          product_id: string
          purchase_price: number | null
          selling_price: number | null
          size: string
          sku: string | null
          stock: number
          updated_at: string | null
          warehouse_id: string
        }
        Insert: {
          barcode?: string | null
          color?: string
          company_id: string
          created_at?: string | null
          id?: string
          product_id: string
          purchase_price?: number | null
          selling_price?: number | null
          size: string
          sku?: string | null
          stock?: number
          updated_at?: string | null
          warehouse_id: string
        }
        Update: {
          barcode?: string | null
          color?: string
          company_id?: string
          created_at?: string | null
          id?: string
          product_id?: string
          purchase_price?: number | null
          selling_price?: number | null
          size?: string
          sku?: string | null
          stock?: number
          updated_at?: string | null
          warehouse_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_sizes_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_sizes_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_sizes_warehouse_id_fkey"
            columns: ["warehouse_id"]
            isOneToOne: false
            referencedRelation: "warehouses"
            referencedColumns: ["id"]
          },
        ]
      }
      products: {
        Row: {
          category: string | null
          colors: string[]
          company_id: string
          created_at: string
          description: string | null
          id: string
          image_url: string | null
          min_stock: number
          name: string
          price: number
          size: string | null
          sizes: string[]
          sku: string | null
          status: string
          updated_at: string
          warehouse_id: string | null
        }
        Insert: {
          category?: string | null
          colors?: string[]
          company_id: string
          created_at?: string
          description?: string | null
          id?: string
          image_url?: string | null
          min_stock?: number
          name: string
          price?: number
          size?: string | null
          sizes?: string[]
          sku?: string | null
          status?: string
          updated_at?: string
          warehouse_id?: string | null
        }
        Update: {
          category?: string | null
          colors?: string[]
          company_id?: string
          created_at?: string
          description?: string | null
          id?: string
          image_url?: string | null
          min_stock?: number
          name?: string
          price?: number
          size?: string | null
          sizes?: string[]
          sku?: string | null
          status?: string
          updated_at?: string
          warehouse_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "products_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "products_warehouse_id_fkey"
            columns: ["warehouse_id"]
            isOneToOne: false
            referencedRelation: "warehouses"
            referencedColumns: ["id"]
          },
        ]
      }
      promotion_products: {
        Row: {
          company_id: string
          created_at: string
          id: string
          product_size_id: string
          promotion_id: string
        }
        Insert: {
          company_id: string
          created_at?: string
          id?: string
          product_size_id: string
          promotion_id: string
        }
        Update: {
          company_id?: string
          created_at?: string
          id?: string
          product_size_id?: string
          promotion_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "promotion_products_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "promotion_products_product_size_id_fkey"
            columns: ["product_size_id"]
            isOneToOne: false
            referencedRelation: "product_sizes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "promotion_products_promotion_id_fkey"
            columns: ["promotion_id"]
            isOneToOne: false
            referencedRelation: "promotions"
            referencedColumns: ["id"]
          },
        ]
      }
      promotions: {
        Row: {
          category: string | null
          company_id: string
          created_at: string
          discount_percent: number
          ends_on: string | null
          id: string
          is_active: boolean
          name: string
          scope_type: string
          starts_on: string | null
          updated_at: string
        }
        Insert: {
          category?: string | null
          company_id: string
          created_at?: string
          discount_percent: number
          ends_on?: string | null
          id?: string
          is_active?: boolean
          name: string
          scope_type: string
          starts_on?: string | null
          updated_at?: string
        }
        Update: {
          category?: string | null
          company_id?: string
          created_at?: string
          discount_percent?: number
          ends_on?: string | null
          id?: string
          is_active?: boolean
          name?: string
          scope_type?: string
          starts_on?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "promotions_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      purchases: {
        Row: {
          amount: number
          company_id: string
          created_at: string
          customer_id: string
          date: string
          id: string
          items: string[]
          payment_method: string | null
        }
        Insert: {
          amount?: number
          company_id: string
          created_at?: string
          customer_id: string
          date?: string
          id?: string
          items?: string[]
          payment_method?: string | null
        }
        Update: {
          amount?: number
          company_id?: string
          created_at?: string
          customer_id?: string
          date?: string
          id?: string
          items?: string[]
          payment_method?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "purchases_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchases_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      requests: {
        Row: {
          company_id: string
          created_at: string
          customer_id: string | null
          customer_name: string | null
          id: string
          message: string | null
          notes: string | null
          priority: string
          status: string
          type: string
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          customer_id?: string | null
          customer_name?: string | null
          id?: string
          message?: string | null
          notes?: string | null
          priority?: string
          status?: string
          type: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          customer_id?: string | null
          customer_name?: string | null
          id?: string
          message?: string | null
          notes?: string | null
          priority?: string
          status?: string
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "requests_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "requests_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      return_items: {
        Row: {
          id: string
          product_size_id: string | null
          quantity: number
          refund_amount: number
          return_id: string
          transaction_item_id: string
        }
        Insert: {
          id?: string
          product_size_id?: string | null
          quantity: number
          refund_amount?: number
          return_id: string
          transaction_item_id: string
        }
        Update: {
          id?: string
          product_size_id?: string | null
          quantity?: number
          refund_amount?: number
          return_id?: string
          transaction_item_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "return_items_product_size_id_fkey"
            columns: ["product_size_id"]
            isOneToOne: false
            referencedRelation: "product_sizes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "return_items_return_id_fkey"
            columns: ["return_id"]
            isOneToOne: false
            referencedRelation: "returns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "return_items_transaction_item_id_fkey"
            columns: ["transaction_item_id"]
            isOneToOne: false
            referencedRelation: "transaction_items"
            referencedColumns: ["id"]
          },
        ]
      }
      returns: {
        Row: {
          company_id: string
          created_at: string
          created_by: string | null
          id: string
          reason: string
          transaction_id: string
        }
        Insert: {
          company_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          reason: string
          transaction_id: string
        }
        Update: {
          company_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          reason?: string
          transaction_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "returns_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "returns_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "returns_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: false
            referencedRelation: "transactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "returns_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: false
            referencedRelation: "transactions_net"
            referencedColumns: ["id"]
          },
        ]
      }
      reward_penalty_entries: {
        Row: {
          amount: number
          company_id: string
          created_at: string
          date: string
          department_name: string | null
          employee_id: string
          employee_name: string | null
          id: string
          note: string | null
          type: string
          type_id: string | null
          type_name: string | null
        }
        Insert: {
          amount?: number
          company_id: string
          created_at?: string
          date?: string
          department_name?: string | null
          employee_id: string
          employee_name?: string | null
          id?: string
          note?: string | null
          type: string
          type_id?: string | null
          type_name?: string | null
        }
        Update: {
          amount?: number
          company_id?: string
          created_at?: string
          date?: string
          department_name?: string | null
          employee_id?: string
          employee_name?: string | null
          id?: string
          note?: string | null
          type?: string
          type_id?: string | null
          type_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "reward_penalty_entries_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reward_penalty_entries_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reward_penalty_entries_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reward_penalty_entries_type_id_fkey"
            columns: ["type_id"]
            isOneToOne: false
            referencedRelation: "reward_penalty_types"
            referencedColumns: ["id"]
          },
        ]
      }
      reward_penalty_types: {
        Row: {
          amount: number
          category: string
          company_id: string
          created_at: string
          description: string | null
          id: string
          kind: string
          name: string
          updated_at: string
        }
        Insert: {
          amount?: number
          category: string
          company_id: string
          created_at?: string
          description?: string | null
          id?: string
          kind: string
          name: string
          updated_at?: string
        }
        Update: {
          amount?: number
          category?: string
          company_id?: string
          created_at?: string
          description?: string | null
          id?: string
          kind?: string
          name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "reward_penalty_types_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      shifts: {
        Row: {
          card_amount: number | null
          cash_amount: number | null
          cashier_id: string | null
          cashier_name: string | null
          click_amount: number | null
          company_id: string
          created_at: string | null
          ended_at: string | null
          id: string
          initial_cash: number | null
          payme_amount: number | null
          started_at: string
          status: string | null
          total_amount: number | null
          total_sales: number | null
        }
        Insert: {
          card_amount?: number | null
          cash_amount?: number | null
          cashier_id?: string | null
          cashier_name?: string | null
          click_amount?: number | null
          company_id: string
          created_at?: string | null
          ended_at?: string | null
          id?: string
          initial_cash?: number | null
          payme_amount?: number | null
          started_at?: string
          status?: string | null
          total_amount?: number | null
          total_sales?: number | null
        }
        Update: {
          card_amount?: number | null
          cash_amount?: number | null
          cashier_id?: string | null
          cashier_name?: string | null
          click_amount?: number | null
          company_id?: string
          created_at?: string | null
          ended_at?: string | null
          id?: string
          initial_cash?: number | null
          payme_amount?: number | null
          started_at?: string
          status?: string | null
          total_amount?: number | null
          total_sales?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "shifts_cashier_id_fkey"
            columns: ["cashier_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shifts_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_in_entries: {
        Row: {
          category: string | null
          color: string | null
          company_id: string
          created_at: string
          date: string
          entry_type: string
          id: string
          note: string | null
          product_id: string | null
          product_name: string | null
          product_size_id: string | null
          purchase_price: number | null
          quantity: number
          selling_price: number | null
          size: string | null
          supplier: string | null
          total_amount: number
          unit_price: number
        }
        Insert: {
          category?: string | null
          color?: string | null
          company_id: string
          created_at?: string
          date?: string
          entry_type?: string
          id?: string
          note?: string | null
          product_id?: string | null
          product_name?: string | null
          product_size_id?: string | null
          purchase_price?: number | null
          quantity?: number
          selling_price?: number | null
          size?: string | null
          supplier?: string | null
          total_amount?: number
          unit_price?: number
        }
        Update: {
          category?: string | null
          color?: string | null
          company_id?: string
          created_at?: string
          date?: string
          entry_type?: string
          id?: string
          note?: string | null
          product_id?: string | null
          product_name?: string | null
          product_size_id?: string | null
          purchase_price?: number | null
          quantity?: number
          selling_price?: number | null
          size?: string | null
          supplier?: string | null
          total_amount?: number
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "stock_in_entries_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_in_entries_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_in_entries_product_size_id_fkey"
            columns: ["product_size_id"]
            isOneToOne: false
            referencedRelation: "product_sizes"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_out_entries: {
        Row: {
          category: string | null
          color: string | null
          company_id: string
          created_at: string
          customer_id: string | null
          customer_name: string | null
          date: string
          entry_type: string | null
          id: string
          note: string | null
          payment_method: string | null
          product_id: string | null
          product_name: string | null
          product_size_id: string | null
          quantity: number
          sell_price: number
          size: string | null
          total_amount: number
        }
        Insert: {
          category?: string | null
          color?: string | null
          company_id: string
          created_at?: string
          customer_id?: string | null
          customer_name?: string | null
          date?: string
          entry_type?: string | null
          id?: string
          note?: string | null
          payment_method?: string | null
          product_id?: string | null
          product_name?: string | null
          product_size_id?: string | null
          quantity?: number
          sell_price?: number
          size?: string | null
          total_amount?: number
        }
        Update: {
          category?: string | null
          color?: string | null
          company_id?: string
          created_at?: string
          customer_id?: string | null
          customer_name?: string | null
          date?: string
          entry_type?: string | null
          id?: string
          note?: string | null
          payment_method?: string | null
          product_id?: string | null
          product_name?: string | null
          product_size_id?: string | null
          quantity?: number
          sell_price?: number
          size?: string | null
          total_amount?: number
        }
        Relationships: [
          {
            foreignKeyName: "stock_out_entries_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_out_entries_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_out_entries_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_out_entries_product_size_id_fkey"
            columns: ["product_size_id"]
            isOneToOne: false
            referencedRelation: "product_sizes"
            referencedColumns: ["id"]
          },
        ]
      }
      transaction_items: {
        Row: {
          company_id: string
          discount_percent: number
          id: string
          list_price: number
          price: number
          product_id: string | null
          product_name: string | null
          product_size_id: string | null
          purchase_price: number | null
          quantity: number
          returned_quantity: number
          transaction_id: string
        }
        Insert: {
          company_id: string
          discount_percent?: number
          id?: string
          list_price?: number
          price?: number
          product_id?: string | null
          product_name?: string | null
          product_size_id?: string | null
          purchase_price?: number | null
          quantity?: number
          returned_quantity?: number
          transaction_id: string
        }
        Update: {
          company_id?: string
          discount_percent?: number
          id?: string
          list_price?: number
          price?: number
          product_id?: string | null
          product_name?: string | null
          product_size_id?: string | null
          purchase_price?: number | null
          quantity?: number
          returned_quantity?: number
          transaction_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "transaction_items_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transaction_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transaction_items_product_size_id_fkey"
            columns: ["product_size_id"]
            isOneToOne: false
            referencedRelation: "product_sizes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transaction_items_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: false
            referencedRelation: "transactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transaction_items_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: false
            referencedRelation: "transactions_net"
            referencedColumns: ["id"]
          },
        ]
      }
      transactions: {
        Row: {
          cashier_id: string | null
          cashier_name: string | null
          company_id: string
          created_at: string
          customer_id: string | null
          customer_name: string | null
          date: string
          id: string
          invoice_id: string | null
          payment_method: string | null
          shift_id: string | null
          status: string
          total_amount: number
        }
        Insert: {
          cashier_id?: string | null
          cashier_name?: string | null
          company_id: string
          created_at?: string
          customer_id?: string | null
          customer_name?: string | null
          date?: string
          id?: string
          invoice_id?: string | null
          payment_method?: string | null
          shift_id?: string | null
          status?: string
          total_amount?: number
        }
        Update: {
          cashier_id?: string | null
          cashier_name?: string | null
          company_id?: string
          created_at?: string
          customer_id?: string | null
          customer_name?: string | null
          date?: string
          id?: string
          invoice_id?: string | null
          payment_method?: string | null
          shift_id?: string | null
          status?: string
          total_amount?: number
        }
        Relationships: [
          {
            foreignKeyName: "transactions_cashier_id_fkey"
            columns: ["cashier_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "shifts"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          company_id: string | null
          created_at: string
          email: string
          full_name: string
          id: string
          permissions: Json
          phone: string | null
          role: string
          status: string
          updated_at: string
        }
        Insert: {
          company_id?: string | null
          created_at?: string
          email: string
          full_name?: string
          id: string
          permissions?: Json
          phone?: string | null
          role?: string
          status?: string
          updated_at?: string
        }
        Update: {
          company_id?: string | null
          created_at?: string
          email?: string
          full_name?: string
          id?: string
          permissions?: Json
          phone?: string | null
          role?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "users_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      warehouses: {
        Row: {
          company_id: string
          created_at: string
          id: string
          name: string
          type: string
        }
        Insert: {
          company_id: string
          created_at?: string
          id?: string
          name: string
          type: string
        }
        Update: {
          company_id?: string
          created_at?: string
          id?: string
          name?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "warehouses_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      employees_safe: {
        Row: {
          address: string | null
          birth_date: string | null
          company_id: string | null
          created_at: string | null
          department_id: string | null
          department_name: string | null
          first_name: string | null
          id: string | null
          last_name: string | null
          phone: string | null
          photo_url: string | null
          position_id: string | null
          position_name: string | null
          salary: number | null
          start_date: string | null
          status: string | null
          updated_at: string | null
        }
        Insert: {
          address?: string | null
          birth_date?: string | null
          company_id?: string | null
          created_at?: string | null
          department_id?: string | null
          department_name?: string | null
          first_name?: string | null
          id?: string | null
          last_name?: string | null
          phone?: string | null
          photo_url?: string | null
          position_id?: string | null
          position_name?: string | null
          salary?: never
          start_date?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Update: {
          address?: string | null
          birth_date?: string | null
          company_id?: string | null
          created_at?: string | null
          department_id?: string | null
          department_name?: string | null
          first_name?: string | null
          id?: string | null
          last_name?: string | null
          phone?: string | null
          photo_url?: string | null
          position_id?: string | null
          position_name?: string | null
          salary?: never
          start_date?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "employees_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_position_id_fkey"
            columns: ["position_id"]
            isOneToOne: false
            referencedRelation: "positions"
            referencedColumns: ["id"]
          },
        ]
      }
      position_history_safe: {
        Row: {
          company_id: string | null
          created_at: string | null
          date: string | null
          department_name: string | null
          employee_id: string | null
          id: string | null
          note: string | null
          position_name: string | null
          salary: number | null
        }
        Insert: {
          company_id?: string | null
          created_at?: string | null
          date?: string | null
          department_name?: string | null
          employee_id?: string | null
          id?: string | null
          note?: string | null
          position_name?: string | null
          salary?: never
        }
        Update: {
          company_id?: string | null
          created_at?: string | null
          date?: string | null
          department_name?: string | null
          employee_id?: string | null
          id?: string | null
          note?: string | null
          position_name?: string | null
          salary?: never
        }
        Relationships: [
          {
            foreignKeyName: "position_history_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "position_history_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "position_history_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      transactions_net: {
        Row: {
          cashier_id: string | null
          cashier_name: string | null
          company_id: string | null
          created_at: string | null
          customer_id: string | null
          customer_name: string | null
          date: string | null
          id: string | null
          invoice_id: string | null
          net_amount: number | null
          payment_method: string | null
          returned_amount: number | null
          shift_id: string | null
          status: string | null
          total_amount: number | null
        }
        Relationships: [
          {
            foreignKeyName: "transactions_cashier_id_fkey"
            columns: ["cashier_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "shifts"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      create_customer: {
        Args: {
          p_address: string | null
          p_email: string | null
          p_full_name: string
          p_phone: string
          p_status?: string
        }
        Returns: string
      }
      create_product: { Args: { p_data: Json }; Returns: string }
      create_product_group: { Args: { p_data: Json }; Returns: string }
      create_promotion: {
        Args: {
          p_category: string | null
          p_discount_percent: number
          p_ends_on: string | null
          p_name: string
          p_product_size_ids: string[]
          p_scope_type: string
          p_starts_on: string | null
        }
        Returns: string
      }
      create_warehouse: {
        Args: { p_name: string; p_type: string }
        Returns: string
      }
      delete_product: { Args: { p_id: string }; Returns: undefined }
      delete_product_group: { Args: { p_id: string }; Returns: undefined }
      delete_promotion: { Args: { p_id: string }; Returns: undefined }
      delete_stock_in_entry: { Args: { p_id: string }; Returns: undefined }
      delete_stock_out_entry: { Args: { p_id: string }; Returns: undefined }
      delete_warehouse: { Args: { p_id: string }; Returns: undefined }
      get_best_promotion_discount: {
        Args: { p_date?: string; p_product_size_id: string }
        Returns: number
      }
      get_company_id: { Args: never; Returns: string }
      get_customer_loyalty_balance: {
        Args: { p_customer_id: string }
        Returns: number
      }
      get_customer_nasiya_balance: {
        Args: { p_customer_id: string }
        Returns: number
      }
      give_nasiya: {
        Args: {
          p_amount: number
          p_customer_id: string
          p_note: string | null
          p_related_transaction_id: string | null
        }
        Returns: undefined
      }
      has_permission: { Args: { p_key: string }; Returns: boolean }
      is_super_admin: { Args: never; Returns: boolean }
      repay_nasiya: {
        Args: { p_amount: number; p_customer_id: string; p_note: string | null }
        Returns: undefined
      }
      return_items: {
        Args: { p_items: Json; p_reason: string; p_transaction_id: string }
        Returns: string
      }
      sell_cart: {
        Args: { p_customer_id: string; p_items: Json; p_payment: Json }
        Returns: string
      }
      set_customer_vip: {
        Args: { p_customer_id: string; p_vip_discount_percent: number | null }
        Returns: undefined
      }
      set_product_size_barcode: {
        Args: { p_barcode: string; p_id: string }
        Returns: undefined
      }
      stock_in: { Args: { p_entries: Json }; Returns: undefined }
      stock_out: {
        Args: { p_entries: Json; p_entry_type: string }
        Returns: undefined
      }
      update_product: {
        Args: { p_data: Json; p_id: string }
        Returns: undefined
      }
      update_product_group: {
        Args: { p_data: Json; p_id: string }
        Returns: undefined
      }
      update_promotion: {
        Args: {
          p_category: string | null
          p_discount_percent: number
          p_ends_on: string | null
          p_id: string
          p_is_active: boolean
          p_name: string
          p_product_size_ids: string[]
          p_scope_type: string
          p_starts_on: string | null
        }
        Returns: undefined
      }
      update_warehouse: {
        Args: { p_id: string; p_name: string; p_type: string }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
