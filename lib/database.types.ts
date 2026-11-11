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
      branches: {
        Row: {
          address: string | null
          company_id: string
          created_at: string
          id: string
          is_active: boolean
          is_default: boolean
          name: string
          phone: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          company_id: string
          created_at?: string
          id?: string
          is_active?: boolean
          is_default?: boolean
          name: string
          phone?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          company_id?: string
          created_at?: string
          id?: string
          is_active?: boolean
          is_default?: boolean
          name?: string
          phone?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "branches_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
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
          branch_limit: number
          address: string | null
          balance: number | null
          billing_status: string | null
          business_type: string
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
          branch_limit?: number
          address?: string | null
          balance?: number | null
          billing_status?: string | null
          business_type?: string
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
          branch_limit?: number
          address?: string | null
          balance?: number | null
          billing_status?: string | null
          business_type?: string
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
          price_list_id: string | null
          status: string
          telegram_id: number | null
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
          price_list_id?: string | null
          status?: string
          telegram_id?: number | null
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
          price_list_id?: string | null
          status?: string
          telegram_id?: number | null
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
      exchange_rates: {
        Row: {
          company_id: string
          created_at: string
          created_by: string | null
          currency: string
          id: string
          rate: number
          rate_date: string
          source: string
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          created_by?: string | null
          currency?: string
          id?: string
          rate: number
          rate_date: string
          source?: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          created_by?: string | null
          currency?: string
          id?: string
          rate?: number
          rate_date?: string
          source?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "exchange_rates_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
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
          business_types: string[]
          created_at: string
          description: string | null
          is_core: boolean
          key: string
          name: string
          price_usd: number
        }
        Insert: {
          business_types?: string[]
          created_at?: string
          description?: string | null
          is_core?: boolean
          key: string
          name: string
          price_usd?: number
        }
        Update: {
          business_types?: string[]
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
      murojat_messages: {
        Row: {
          company_id: string
          customer_id: string | null
          id: string
          message: string
          request_id: string
          sender: string
          sent_at: string | null
          telegram_message_id: number | null
        }
        Insert: {
          company_id: string
          customer_id?: string | null
          id?: string
          message: string
          request_id: string
          sender: string
          sent_at?: string | null
          telegram_message_id?: number | null
        }
        Update: {
          company_id?: string
          customer_id?: string | null
          id?: string
          message?: string
          request_id?: string
          sender?: string
          sent_at?: string | null
          telegram_message_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "murojat_messages_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "murojat_messages_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "murojat_messages_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "requests"
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
          companion_product_size_id: string | null
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
          companion_product_size_id?: string | null
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
          companion_product_size_id?: string | null
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
            foreignKeyName: "product_sizes_companion_product_size_id_fkey"
            columns: ["companion_product_size_id"]
            isOneToOne: false
            referencedRelation: "product_sizes"
            referencedColumns: ["id"]
          },
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
          barcode: string | null
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
          barcode?: string | null
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
          barcode?: string | null
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
          mode: string
          notes: string | null
          priority: string
          source: string
          status: string
          ticket_number: number
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
          mode?: string
          notes?: string | null
          priority?: string
          source?: string
          status?: string
          ticket_number?: number
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
          mode?: string
          notes?: string | null
          priority?: string
          source?: string
          status?: string
          ticket_number?: number
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
      price_list_items: {
        Row: {
          company_id: string
          price: number
          price_list_id: string
          product_size_id: string
        }
        Insert: {
          company_id: string
          price: number
          price_list_id: string
          product_size_id: string
        }
        Update: {
          company_id?: string
          price?: number
          price_list_id?: string
          product_size_id?: string
        }
        Relationships: []
      }
      price_lists: {
        Row: {
          adjust_percent: number
          base: string
          company_id: string
          created_at: string
          id: string
          is_active: boolean
          name: string
          rounding: number
        }
        Insert: {
          adjust_percent?: number
          base?: string
          company_id: string
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          rounding?: number
        }
        Update: {
          adjust_percent?: number
          base?: string
          company_id?: string
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          rounding?: number
        }
        Relationships: []
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
      stock_count_items: {
        Row: {
          company_id: string
          count_id: string
          counted_qty: number
          created_at: string
          expected_qty: number | null
          id: string
          product_size_id: string
          purchase_price: number | null
          updated_at: string
        }
        Insert: {
          company_id: string
          count_id: string
          counted_qty: number
          created_at?: string
          expected_qty?: number | null
          id?: string
          product_size_id: string
          purchase_price?: number | null
          updated_at?: string
        }
        Update: {
          company_id?: string
          count_id?: string
          counted_qty?: number
          created_at?: string
          expected_qty?: number | null
          id?: string
          product_size_id?: string
          purchase_price?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "stock_count_items_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_count_items_count_id_fkey"
            columns: ["count_id"]
            isOneToOne: false
            referencedRelation: "stock_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_count_items_product_size_id_fkey"
            columns: ["product_size_id"]
            isOneToOne: false
            referencedRelation: "product_sizes"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_transfer_items: {
        Row: {
          category: string | null
          color: string
          company_id: string
          created_at: string
          from_product_size_id: string | null
          id: string
          product_id: string | null
          product_name: string
          purchase_price: number
          quantity: number
          size: string
          to_product_size_id: string | null
          transfer_id: string
        }
        Insert: {
          category?: string | null
          color?: string
          company_id: string
          created_at?: string
          from_product_size_id?: string | null
          id?: string
          product_id?: string | null
          product_name: string
          purchase_price?: number
          quantity: number
          size: string
          to_product_size_id?: string | null
          transfer_id: string
        }
        Update: {
          category?: string | null
          color?: string
          company_id?: string
          created_at?: string
          from_product_size_id?: string | null
          id?: string
          product_id?: string | null
          product_name?: string
          purchase_price?: number
          quantity?: number
          size?: string
          to_product_size_id?: string | null
          transfer_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stock_transfer_items_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_transfer_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_transfer_items_transfer_id_fkey"
            columns: ["transfer_id"]
            isOneToOne: false
            referencedRelation: "stock_transfers"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_transfers: {
        Row: {
          company_id: string
          created_at: string
          created_by: string | null
          created_by_name: string | null
          date: string
          from_warehouse_id: string
          id: string
          note: string | null
          number: number
          to_warehouse_id: string
        }
        Insert: {
          company_id: string
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          date?: string
          from_warehouse_id: string
          id?: string
          note?: string | null
          number: number
          to_warehouse_id: string
        }
        Update: {
          company_id?: string
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          date?: string
          from_warehouse_id?: string
          id?: string
          note?: string | null
          number?: number
          to_warehouse_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stock_transfers_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_transfers_from_warehouse_id_fkey"
            columns: ["from_warehouse_id"]
            isOneToOne: false
            referencedRelation: "warehouses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_transfers_to_warehouse_id_fkey"
            columns: ["to_warehouse_id"]
            isOneToOne: false
            referencedRelation: "warehouses"
            referencedColumns: ["id"]
          },
        ]
      }
      supplier_payments: {
        Row: {
          amount: number
          company_id: string
          created_at: string
          created_by: string | null
          created_by_name: string | null
          date: string
          id: string
          note: string | null
          payment_method: string
          supplier_id: string
        }
        Insert: {
          amount: number
          company_id: string
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          date?: string
          id?: string
          note?: string | null
          payment_method?: string
          supplier_id: string
        }
        Update: {
          amount?: number
          company_id?: string
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          date?: string
          id?: string
          note?: string | null
          payment_method?: string
          supplier_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "supplier_payments_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_payments_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      supplier_return_items: {
        Row: {
          category: string | null
          color: string
          company_id: string
          created_at: string
          id: string
          price: number
          product_id: string | null
          product_name: string
          product_size_id: string | null
          quantity: number
          return_id: string
          size: string
        }
        Insert: {
          category?: string | null
          color?: string
          company_id: string
          created_at?: string
          id?: string
          price: number
          product_id?: string | null
          product_name: string
          product_size_id?: string | null
          quantity: number
          return_id: string
          size: string
        }
        Update: {
          category?: string | null
          color?: string
          company_id?: string
          created_at?: string
          id?: string
          price?: number
          product_id?: string | null
          product_name?: string
          product_size_id?: string | null
          quantity?: number
          return_id?: string
          size?: string
        }
        Relationships: [
          {
            foreignKeyName: "supplier_return_items_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_return_items_return_id_fkey"
            columns: ["return_id"]
            isOneToOne: false
            referencedRelation: "supplier_returns"
            referencedColumns: ["id"]
          },
        ]
      }
      supplier_returns: {
        Row: {
          company_id: string
          created_at: string
          created_by: string | null
          created_by_name: string | null
          date: string
          id: string
          note: string | null
          number: number
          supplier_id: string
          warehouse_id: string
        }
        Insert: {
          company_id: string
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          date?: string
          id?: string
          note?: string | null
          number: number
          supplier_id: string
          warehouse_id: string
        }
        Update: {
          company_id?: string
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          date?: string
          id?: string
          note?: string | null
          number?: number
          supplier_id?: string
          warehouse_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "supplier_returns_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_returns_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_returns_warehouse_id_fkey"
            columns: ["warehouse_id"]
            isOneToOne: false
            referencedRelation: "warehouses"
            referencedColumns: ["id"]
          },
        ]
      }
      suppliers: {
        Row: {
          address: string | null
          company_id: string
          company_name: string | null
          created_at: string
          id: string
          inn: string | null
          is_active: boolean
          name: string
          note: string | null
          opening_balance: number
          phone: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          company_id: string
          company_name?: string | null
          created_at?: string
          id?: string
          inn?: string | null
          is_active?: boolean
          name: string
          note?: string | null
          opening_balance?: number
          phone?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          company_id?: string
          company_name?: string | null
          created_at?: string
          id?: string
          inn?: string | null
          is_active?: boolean
          name?: string
          note?: string | null
          opening_balance?: number
          phone?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "suppliers_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_counts: {
        Row: {
          company_id: string
          completed_at: string | null
          completed_by: string | null
          created_at: string
          created_by: string | null
          id: string
          note: string | null
          number: number
          status: string
          updated_at: string
          warehouse_id: string
          zero_uncounted: boolean
        }
        Insert: {
          company_id: string
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          number: number
          status?: string
          updated_at?: string
          warehouse_id: string
          zero_uncounted?: boolean
        }
        Update: {
          company_id?: string
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          number?: number
          status?: string
          updated_at?: string
          warehouse_id?: string
          zero_uncounted?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "stock_counts_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_counts_warehouse_id_fkey"
            columns: ["warehouse_id"]
            isOneToOne: false
            referencedRelation: "warehouses"
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
          supplier_id: string | null
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
          supplier_id?: string | null
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
          supplier_id?: string | null
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
          is_gift: boolean
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
          is_gift?: boolean
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
          is_gift?: boolean
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
          manual_discount: number
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
          manual_discount?: number
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
          manual_discount?: number
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
      // Production module (business_type = 'production'), hand-written from
      // supabase/migrations/20261110000003_production_core.sql. Writes go
      // through the prod_* / supply_* RPCs only (INSERT/UPDATE/DELETE revoked).
      prod_item_groups: {
        Row: {
          id: string
          company_id: string
          name: string
          is_active: boolean
          created_at: string
        }
        Insert: {
          id?: string
          company_id?: string
          name?: string
          is_active?: boolean
          created_at?: string
        }
        Update: {
          id?: string
          company_id?: string
          name?: string
          is_active?: boolean
          created_at?: string
        }
        Relationships: []
      }
      prod_items: {
        Row: {
          id: string
          company_id: string
          group_id: string | null
          name: string
          sku: string | null
          barcode: string | null
          unit: string
          weight_kg: number | null
          item_type: string
          min_stock: number | null
          max_stock: number | null
          is_active: boolean
          description: string | null
          shelf_life_days: number | null
          created_at: string
          updated_at: string
          standard_cost: number | null
          sale_price: number | null
          expiry_warn_days: number | null
        }
        Insert: {
          id?: string
          company_id?: string
          group_id?: string | null
          name?: string
          sku?: string | null
          barcode?: string | null
          unit?: string
          weight_kg?: number | null
          item_type?: string
          min_stock?: number | null
          max_stock?: number | null
          is_active?: boolean
          description?: string | null
          shelf_life_days?: number | null
          created_at?: string
          updated_at?: string
          standard_cost?: number | null
          sale_price?: number | null
          expiry_warn_days?: number | null
        }
        Update: {
          id?: string
          company_id?: string
          group_id?: string | null
          name?: string
          sku?: string | null
          barcode?: string | null
          unit?: string
          weight_kg?: number | null
          item_type?: string
          min_stock?: number | null
          max_stock?: number | null
          is_active?: boolean
          description?: string | null
          shelf_life_days?: number | null
          created_at?: string
          updated_at?: string
          standard_cost?: number | null
          sale_price?: number | null
          expiry_warn_days?: number | null
        }
        Relationships: []
      }
      prod_warehouses: {
        Row: {
          id: string
          company_id: string
          name: string
          storage_types: string[]
          is_active: boolean
          created_at: string
        }
        Insert: {
          id?: string
          company_id?: string
          name?: string
          storage_types?: string[]
          is_active?: boolean
          created_at?: string
        }
        Update: {
          id?: string
          company_id?: string
          name?: string
          storage_types?: string[]
          is_active?: boolean
          created_at?: string
        }
        Relationships: []
      }
      prod_stock_movements: {
        Row: {
          id: string
          company_id: string
          warehouse_id: string
          item_id: string
          qty: number
          unit_cost: number
          doc_type: string
          doc_id: string
          is_reversal: boolean
          fat_pct: number | null
          protein_pct: number | null
          lot_id: string | null
          created_by: string | null
          created_at: string
        }
        Insert: {
          id?: string
          company_id?: string
          warehouse_id?: string
          item_id?: string
          qty?: number
          unit_cost?: number
          doc_type?: string
          doc_id?: string
          is_reversal?: boolean
          fat_pct?: number | null
          protein_pct?: number | null
          lot_id?: string | null
          created_by?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          company_id?: string
          warehouse_id?: string
          item_id?: string
          qty?: number
          unit_cost?: number
          doc_type?: string
          doc_id?: string
          is_reversal?: boolean
          fat_pct?: number | null
          protein_pct?: number | null
          lot_id?: string | null
          created_by?: string | null
          created_at?: string
        }
        Relationships: []
      }
      prod_lots: {
        Row: {
          id: string
          company_id: string
          warehouse_id: string
          item_id: string
          lot_no: string
          received_at: string
          opening_qty: number
          unit_cost: number
          fat_pct: number | null
          protein_pct: number | null
          supplier_id: string | null
          source_doc_type: string | null
          source_doc_id: string | null
          origin_lot_id: string | null
          expiry_date: string | null
          is_opening: boolean
          created_at: string
          hold_status: string
          hold_reason: string | null
          hold_at: string | null
          hold_by: string | null
        }
        Insert: {
          id?: string
          company_id?: string
          warehouse_id?: string
          item_id?: string
          lot_no?: string
          received_at?: string
          opening_qty?: number
          unit_cost?: number
          fat_pct?: number | null
          protein_pct?: number | null
          supplier_id?: string | null
          source_doc_type?: string | null
          source_doc_id?: string | null
          origin_lot_id?: string | null
          expiry_date?: string | null
          is_opening?: boolean
          created_at?: string
          hold_status?: string
          hold_reason?: string | null
          hold_at?: string | null
          hold_by?: string | null
        }
        Update: {
          id?: string
          company_id?: string
          warehouse_id?: string
          item_id?: string
          lot_no?: string
          received_at?: string
          opening_qty?: number
          unit_cost?: number
          fat_pct?: number | null
          protein_pct?: number | null
          supplier_id?: string | null
          source_doc_type?: string | null
          source_doc_id?: string | null
          origin_lot_id?: string | null
          expiry_date?: string | null
          is_opening?: boolean
          created_at?: string
          hold_status?: string
          hold_reason?: string | null
          hold_at?: string | null
          hold_by?: string | null
        }
        Relationships: []
      }
      prod_receipts: {
        Row: {
          id: string
          company_id: string
          number: number
          doc_date: string
          warehouse_id: string
          supplier_id: string | null
          supplier_name: string | null
          note: string | null
          total: number
          status: string
          created_by: string | null
          created_by_name: string | null
          created_at: string
          cancelled_at: string | null
          cancelled_by: string | null
          due_date: string | null
          // Accounting (migration 20261110000018); undefined before it. total = gross incl. VAT.
          prices_include_vat?: boolean
          vat_deductible?: boolean
          vat_total?: number
        }
        Insert: {
          id?: string
          company_id?: string
          number?: number
          doc_date?: string
          warehouse_id?: string
          supplier_id?: string | null
          supplier_name?: string | null
          note?: string | null
          total?: number
          status?: string
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
          due_date?: string | null
        }
        Update: {
          id?: string
          company_id?: string
          number?: number
          doc_date?: string
          warehouse_id?: string
          supplier_id?: string | null
          supplier_name?: string | null
          note?: string | null
          total?: number
          status?: string
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
          due_date?: string | null
        }
        Relationships: []
      }
      prod_receipt_items: {
        Row: {
          id: string
          company_id: string
          receipt_id: string
          item_id: string
          qty: number
          price: number
          total: number
          // Accounting (migration 20261110000018); undefined before it. total = gross incl. VAT.
          vat_rate?: number
          vat_amount?: number
        }
        Insert: {
          id?: string
          company_id?: string
          receipt_id?: string
          item_id?: string
          qty?: number
          price?: number
          total?: number
        }
        Update: {
          id?: string
          company_id?: string
          receipt_id?: string
          item_id?: string
          qty?: number
          price?: number
          total?: number
        }
        Relationships: []
      }
      prod_suppliers: {
        Row: {
          id: string
          company_id: string
          name: string
          phone: string | null
          address: string | null
          note: string | null
          is_active: boolean
          milk_price_per_kg: number | null
          created_at: string
          updated_at: string
          payment_terms_days: number | null
        }
        Insert: {
          id?: string
          company_id?: string
          name?: string
          phone?: string | null
          address?: string | null
          note?: string | null
          is_active?: boolean
          milk_price_per_kg?: number | null
          created_at?: string
          updated_at?: string
          payment_terms_days?: number | null
        }
        Update: {
          id?: string
          company_id?: string
          name?: string
          phone?: string | null
          address?: string | null
          note?: string | null
          is_active?: boolean
          milk_price_per_kg?: number | null
          created_at?: string
          updated_at?: string
          payment_terms_days?: number | null
        }
        Relationships: []
      }
      prod_milk_settings: {
        Row: {
          company_id: string
          milk_item_id: string | null
          default_warehouse_id: string | null
          base_fat: number
          base_protein: number
          pricing_mode: string
          default_price_per_kg: number
          default_density: number
          min_fat: number
          min_density: number
          max_acidity: number
          max_temperature: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          company_id?: string
          milk_item_id?: string | null
          default_warehouse_id?: string | null
          base_fat?: number
          base_protein?: number
          pricing_mode?: string
          default_price_per_kg?: number
          default_density?: number
          min_fat?: number
          min_density?: number
          max_acidity?: number
          max_temperature?: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          company_id?: string
          milk_item_id?: string | null
          default_warehouse_id?: string | null
          base_fat?: number
          base_protein?: number
          pricing_mode?: string
          default_price_per_kg?: number
          default_density?: number
          min_fat?: number
          min_density?: number
          max_acidity?: number
          max_temperature?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      prod_milk_intakes: {
        Row: {
          id: string
          company_id: string
          number: number
          intake_date: string
          supplier_id: string
          warehouse_id: string
          item_id: string
          vehicle_no: string | null
          driver: string | null
          gross_kg: number
          tare_kg: number
          net_kg: number
          density: number | null
          volume_l: number | null
          fat_pct: number | null
          protein_pct: number | null
          snf_pct: number | null
          acidity: number | null
          temperature: number | null
          antibiotic: string | null
          status: string
          pricing_mode: string | null
          base_price_per_kg: number | null
          credited_kg: number | null
          price_per_kg: number | null
          amount: number | null
          receipt_id: string | null
          decision_note: string | null
          note: string | null
          lab_by: string | null
          lab_by_name: string | null
          lab_at: string | null
          created_by: string | null
          created_by_name: string | null
          created_at: string
          cancelled_at: string | null
          cancelled_by: string | null
          lab_amended_at: string | null
          lab_amend_count: number
        }
        Insert: {
          id?: string
          company_id?: string
          number?: number
          intake_date?: string
          supplier_id?: string
          warehouse_id?: string
          item_id?: string
          vehicle_no?: string | null
          driver?: string | null
          gross_kg?: number
          tare_kg?: number
          net_kg?: number
          density?: number | null
          volume_l?: number | null
          fat_pct?: number | null
          protein_pct?: number | null
          snf_pct?: number | null
          acidity?: number | null
          temperature?: number | null
          antibiotic?: string | null
          status?: string
          pricing_mode?: string | null
          base_price_per_kg?: number | null
          credited_kg?: number | null
          price_per_kg?: number | null
          amount?: number | null
          receipt_id?: string | null
          decision_note?: string | null
          note?: string | null
          lab_by?: string | null
          lab_by_name?: string | null
          lab_at?: string | null
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
          lab_amended_at?: string | null
          lab_amend_count?: number
        }
        Update: {
          id?: string
          company_id?: string
          number?: number
          intake_date?: string
          supplier_id?: string
          warehouse_id?: string
          item_id?: string
          vehicle_no?: string | null
          driver?: string | null
          gross_kg?: number
          tare_kg?: number
          net_kg?: number
          density?: number | null
          volume_l?: number | null
          fat_pct?: number | null
          protein_pct?: number | null
          snf_pct?: number | null
          acidity?: number | null
          temperature?: number | null
          antibiotic?: string | null
          status?: string
          pricing_mode?: string | null
          base_price_per_kg?: number | null
          credited_kg?: number | null
          price_per_kg?: number | null
          amount?: number | null
          receipt_id?: string | null
          decision_note?: string | null
          note?: string | null
          lab_by?: string | null
          lab_by_name?: string | null
          lab_at?: string | null
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
          lab_amended_at?: string | null
          lab_amend_count?: number
        }
        Relationships: []
      }
      prod_supplier_payments: {
        Row: {
          id: string
          company_id: string
          number: number
          supplier_id: string
          amount: number
          method: string
          pay_date: string
          note: string | null
          status: string
          created_by: string | null
          created_by_name: string | null
          created_at: string
          cancelled_at: string | null
          cancelled_by: string | null
          // Cash & bank (migration 20261110000016); undefined before it.
          account_id?: string | null
        }
        Insert: {
          id?: string
          company_id?: string
          number?: number
          supplier_id?: string
          amount?: number
          method?: string
          pay_date?: string
          note?: string | null
          status?: string
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
          account_id?: string | null
        }
        Update: {
          id?: string
          company_id?: string
          number?: number
          supplier_id?: string
          amount?: number
          method?: string
          pay_date?: string
          note?: string | null
          status?: string
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
          account_id?: string | null
        }
        Relationships: []
      }
      prod_transfers: {
        Row: {
          id: string
          company_id: string
          number: number
          doc_date: string
          from_warehouse_id: string
          to_warehouse_id: string
          note: string | null
          total: number
          status: string
          created_by: string | null
          created_by_name: string | null
          created_at: string
          cancelled_at: string | null
          cancelled_by: string | null
          // Controls (migration 20261110000017); undefined before it.
          lot_pick_deviation?: boolean
        }
        Insert: {
          id?: string
          company_id?: string
          number?: number
          doc_date?: string
          from_warehouse_id?: string
          to_warehouse_id?: string
          note?: string | null
          total?: number
          status?: string
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
        }
        Update: {
          id?: string
          company_id?: string
          number?: number
          doc_date?: string
          from_warehouse_id?: string
          to_warehouse_id?: string
          note?: string | null
          total?: number
          status?: string
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
        }
        Relationships: []
      }
      prod_transfer_items: {
        Row: {
          id: string
          company_id: string
          transfer_id: string
          item_id: string
          qty: number
          unit_cost: number
          total: number
        }
        Insert: {
          id?: string
          company_id?: string
          transfer_id?: string
          item_id?: string
          qty?: number
          unit_cost?: number
          total?: number
        }
        Update: {
          id?: string
          company_id?: string
          transfer_id?: string
          item_id?: string
          qty?: number
          unit_cost?: number
          total?: number
        }
        Relationships: []
      }
      prod_productions: {
        Row: {
          id: string
          company_id: string
          number: number
          doc_date: string
          warehouse_id: string
          output_item_id: string
          output_qty: number
          total_cost: number
          unit_cost: number
          note: string | null
          status: string
          created_by: string | null
          created_by_name: string | null
          created_at: string
          cancelled_at: string | null
          cancelled_by: string | null
          recipe_id: string | null
          recipe_version: number | null
          output_warehouse_id: string | null
          // Controls (migration 20261110000017); undefined before it.
          lot_pick_deviation?: boolean
          // Accounting (migration 20261110000018); undefined before it.
          allocation_method?: string
        }
        Insert: {
          id?: string
          company_id?: string
          number?: number
          doc_date?: string
          warehouse_id?: string
          output_item_id?: string
          output_qty?: number
          total_cost?: number
          unit_cost?: number
          note?: string | null
          status?: string
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
          recipe_id?: string | null
          recipe_version?: number | null
          output_warehouse_id?: string | null
        }
        Update: {
          id?: string
          company_id?: string
          number?: number
          doc_date?: string
          warehouse_id?: string
          output_item_id?: string
          output_qty?: number
          total_cost?: number
          unit_cost?: number
          note?: string | null
          status?: string
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
          recipe_id?: string | null
          recipe_version?: number | null
          output_warehouse_id?: string | null
        }
        Relationships: []
      }
      prod_production_components: {
        Row: {
          id: string
          company_id: string
          production_id: string
          item_id: string
          qty: number
          unit_cost: number
          total: number
          planned_qty: number | null
        }
        Insert: {
          id?: string
          company_id?: string
          production_id?: string
          item_id?: string
          qty?: number
          unit_cost?: number
          total?: number
          planned_qty?: number | null
        }
        Update: {
          id?: string
          company_id?: string
          production_id?: string
          item_id?: string
          qty?: number
          unit_cost?: number
          total?: number
          planned_qty?: number | null
        }
        Relationships: []
      }
      prod_recipes: {
        Row: {
          id: string
          company_id: string
          item_id: string
          output_qty: number
          version: number
          is_active: boolean
          note: string | null
          created_by: string | null
          created_by_name: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          company_id?: string
          item_id?: string
          output_qty?: number
          version?: number
          is_active?: boolean
          note?: string | null
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          company_id?: string
          item_id?: string
          output_qty?: number
          version?: number
          is_active?: boolean
          note?: string | null
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      prod_recipe_lines: {
        Row: {
          id: string
          company_id: string
          recipe_id: string
          item_id: string
          qty: number
          sort_order: number
          note: string | null
        }
        Insert: {
          id?: string
          company_id?: string
          recipe_id?: string
          item_id?: string
          qty?: number
          sort_order?: number
          note?: string | null
        }
        Update: {
          id?: string
          company_id?: string
          recipe_id?: string
          item_id?: string
          qty?: number
          sort_order?: number
          note?: string | null
        }
        Relationships: []
      }
      prod_processings: {
        Row: {
          id: string
          company_id: string
          number: number
          doc_date: string
          warehouse_id: string
          source_item_id: string
          source_qty: number
          source_unit_cost: number
          processing_cost: number
          recovery_cost: number
          profit: number
          note: string | null
          status: string
          created_by: string | null
          created_by_name: string | null
          created_at: string
          cancelled_at: string | null
          cancelled_by: string | null
          output_warehouse_id: string | null
          // Controls (migration 20261110000017); undefined before it.
          lot_pick_deviation?: boolean
        }
        Insert: {
          id?: string
          company_id?: string
          number?: number
          doc_date?: string
          warehouse_id?: string
          source_item_id?: string
          source_qty?: number
          source_unit_cost?: number
          processing_cost?: number
          recovery_cost?: number
          profit?: number
          note?: string | null
          status?: string
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
          output_warehouse_id?: string | null
        }
        Update: {
          id?: string
          company_id?: string
          number?: number
          doc_date?: string
          warehouse_id?: string
          source_item_id?: string
          source_qty?: number
          source_unit_cost?: number
          processing_cost?: number
          recovery_cost?: number
          profit?: number
          note?: string | null
          status?: string
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
          output_warehouse_id?: string | null
        }
        Relationships: []
      }
      prod_processing_outputs: {
        Row: {
          id: string
          company_id: string
          processing_id: string
          item_id: string
          qty: number
          price: number
          total: number
        }
        Insert: {
          id?: string
          company_id?: string
          processing_id?: string
          item_id?: string
          qty?: number
          price?: number
          total?: number
        }
        Update: {
          id?: string
          company_id?: string
          processing_id?: string
          item_id?: string
          qty?: number
          price?: number
          total?: number
        }
        Relationships: []
      }
      // Wholesale sales (migration 20261110000015, hand-written).
      prod_customers: {
        Row: {
          id: string
          company_id: string
          name: string
          legal_name: string | null
          inn: string | null
          phone: string | null
          address: string | null
          contact_person: string | null
          price_list_id: string | null
          credit_limit: number | null
          payment_terms_days: number | null
          vat_payer: boolean
          note: string | null
          is_active: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          company_id?: string
          name?: string
          legal_name?: string | null
          inn?: string | null
          phone?: string | null
          address?: string | null
          contact_person?: string | null
          price_list_id?: string | null
          credit_limit?: number | null
          payment_terms_days?: number | null
          vat_payer?: boolean
          note?: string | null
          is_active?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          company_id?: string
          name?: string
          legal_name?: string | null
          inn?: string | null
          phone?: string | null
          address?: string | null
          contact_person?: string | null
          price_list_id?: string | null
          credit_limit?: number | null
          payment_terms_days?: number | null
          vat_payer?: boolean
          note?: string | null
          is_active?: boolean
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      prod_price_lists: {
        Row: {
          id: string
          company_id: string
          name: string
          currency: string
          is_default: boolean
          is_active: boolean
          note: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          company_id?: string
          name?: string
          currency?: string
          is_default?: boolean
          is_active?: boolean
          note?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          company_id?: string
          name?: string
          currency?: string
          is_default?: boolean
          is_active?: boolean
          note?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      prod_price_list_items: {
        Row: {
          id: string
          company_id: string
          price_list_id: string
          item_id: string
          price: number
        }
        Insert: {
          id?: string
          company_id?: string
          price_list_id?: string
          item_id?: string
          price?: number
        }
        Update: {
          id?: string
          company_id?: string
          price_list_id?: string
          item_id?: string
          price?: number
        }
        Relationships: []
      }
      prod_sales: {
        Row: {
          id: string
          company_id: string
          number: number
          doc_date: string
          customer_id: string
          customer_name: string
          warehouse_id: string
          price_list_id: string | null
          due_date: string | null
          vat_rate: number
          subtotal: number
          vat_amount: number
          total: number
          cost_total: number
          margin: number
          vehicle_no: string | null
          driver: string | null
          note: string | null
          status: string
          created_by: string | null
          created_by_name: string | null
          created_at: string
          cancelled_at: string | null
          cancelled_by: string | null
          // Controls (migration 20261110000017); undefined before it.
          lot_pick_deviation?: boolean
        }
        Insert: {
          id?: string
          company_id?: string
          number?: number
          doc_date?: string
          customer_id?: string
          customer_name?: string
          warehouse_id?: string
          price_list_id?: string | null
          due_date?: string | null
          vat_rate?: number
          subtotal?: number
          vat_amount?: number
          total?: number
          cost_total?: number
          margin?: number
          vehicle_no?: string | null
          driver?: string | null
          note?: string | null
          status?: string
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
        }
        Update: {
          id?: string
          company_id?: string
          number?: number
          doc_date?: string
          customer_id?: string
          customer_name?: string
          warehouse_id?: string
          price_list_id?: string | null
          due_date?: string | null
          vat_rate?: number
          subtotal?: number
          vat_amount?: number
          total?: number
          cost_total?: number
          margin?: number
          vehicle_no?: string | null
          driver?: string | null
          note?: string | null
          status?: string
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
        }
        Relationships: []
      }
      prod_sale_items: {
        Row: {
          id: string
          company_id: string
          sale_id: string
          sort_order: number
          item_id: string
          unit: string
          qty: number
          price: number
          discount_pct: number
          price_source: string
          amount: number
          vat_amount: number
          total: number
          cost: number
          unit_cost: number
          lots: Json
        }
        Insert: {
          id?: string
          company_id?: string
          sale_id?: string
          sort_order?: number
          item_id?: string
          unit?: string
          qty?: number
          price?: number
          discount_pct?: number
          price_source?: string
          amount?: number
          vat_amount?: number
          total?: number
          cost?: number
          unit_cost?: number
          lots?: Json
        }
        Update: {
          id?: string
          company_id?: string
          sale_id?: string
          sort_order?: number
          item_id?: string
          unit?: string
          qty?: number
          price?: number
          discount_pct?: number
          price_source?: string
          amount?: number
          vat_amount?: number
          total?: number
          cost?: number
          unit_cost?: number
          lots?: Json
        }
        Relationships: []
      }
      prod_sale_returns: {
        Row: {
          id: string
          company_id: string
          number: number
          doc_date: string
          sale_id: string
          customer_id: string
          warehouse_id: string
          reason: string | null
          note: string | null
          subtotal: number
          vat_amount: number
          total: number
          cost_total: number
          loss_cost: number
          status: string
          created_by: string | null
          created_by_name: string | null
          created_at: string
          cancelled_at: string | null
          cancelled_by: string | null
        }
        Insert: {
          id?: string
          company_id?: string
          number?: number
          doc_date?: string
          sale_id?: string
          customer_id?: string
          warehouse_id?: string
          reason?: string | null
          note?: string | null
          subtotal?: number
          vat_amount?: number
          total?: number
          cost_total?: number
          loss_cost?: number
          status?: string
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
        }
        Update: {
          id?: string
          company_id?: string
          number?: number
          doc_date?: string
          sale_id?: string
          customer_id?: string
          warehouse_id?: string
          reason?: string | null
          note?: string | null
          subtotal?: number
          vat_amount?: number
          total?: number
          cost_total?: number
          loss_cost?: number
          status?: string
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
        }
        Relationships: []
      }
      prod_sale_return_items: {
        Row: {
          id: string
          company_id: string
          return_id: string
          sale_item_id: string
          item_id: string
          sort_order: number
          qty: number
          restock: boolean
          price: number
          discount_pct: number
          amount: number
          vat_amount: number
          total: number
          cost: number
          lots: Json
        }
        Insert: {
          id?: string
          company_id?: string
          return_id?: string
          sale_item_id?: string
          item_id?: string
          sort_order?: number
          qty?: number
          restock?: boolean
          price?: number
          discount_pct?: number
          amount?: number
          vat_amount?: number
          total?: number
          cost?: number
          lots?: Json
        }
        Update: {
          id?: string
          company_id?: string
          return_id?: string
          sale_item_id?: string
          item_id?: string
          sort_order?: number
          qty?: number
          restock?: boolean
          price?: number
          discount_pct?: number
          amount?: number
          vat_amount?: number
          total?: number
          cost?: number
          lots?: Json
        }
        Relationships: []
      }
      prod_customer_payments: {
        Row: {
          id: string
          company_id: string
          number: number
          customer_id: string
          amount: number
          method: string
          pay_date: string
          note: string | null
          status: string
          created_by: string | null
          created_by_name: string | null
          created_at: string
          cancelled_at: string | null
          cancelled_by: string | null
          // Cash & bank (migration 20261110000016); undefined before it.
          account_id?: string | null
        }
        Insert: {
          id?: string
          company_id?: string
          number?: number
          customer_id?: string
          amount?: number
          method?: string
          pay_date?: string
          note?: string | null
          status?: string
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
          account_id?: string | null
        }
        Update: {
          id?: string
          company_id?: string
          number?: number
          customer_id?: string
          amount?: number
          method?: string
          pay_date?: string
          note?: string | null
          status?: string
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
          account_id?: string | null
        }
        Relationships: []
      }
      prod_writeoffs: {
        Row: {
          id: string
          company_id: string
          number: number
          doc_date: string
          warehouse_id: string
          reason: string
          note: string | null
          total_cost: number
          status: string
          created_by: string | null
          created_by_name: string | null
          created_at: string
          cancelled_at: string | null
          cancelled_by: string | null
          // Controls (migration 20261110000017); undefined before it.
          lot_pick_deviation?: boolean
        }
        Insert: {
          id?: string
          company_id?: string
          number?: number
          doc_date?: string
          warehouse_id?: string
          reason?: string
          note?: string | null
          total_cost?: number
          status?: string
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
        }
        Update: {
          id?: string
          company_id?: string
          number?: number
          doc_date?: string
          warehouse_id?: string
          reason?: string
          note?: string | null
          total_cost?: number
          status?: string
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
        }
        Relationships: []
      }
      prod_writeoff_items: {
        Row: {
          id: string
          company_id: string
          writeoff_id: string
          item_id: string
          qty: number
          unit_cost: number
          total: number
        }
        Insert: {
          id?: string
          company_id?: string
          writeoff_id?: string
          item_id?: string
          qty?: number
          unit_cost?: number
          total?: number
        }
        Update: {
          id?: string
          company_id?: string
          writeoff_id?: string
          item_id?: string
          qty?: number
          unit_cost?: number
          total?: number
        }
        Relationships: []
      }
      prod_stock_counts: {
        Row: {
          id: string
          company_id: string
          number: number
          doc_date: string
          warehouse_id: string
          note: string | null
          status: string
          shortage_value: number
          surplus_value: number
          created_by: string | null
          created_by_name: string | null
          created_at: string
          updated_at: string
          posted_at: string | null
          posted_by: string | null
          posted_by_name: string | null
          cancelled_at: string | null
          cancelled_by: string | null
        }
        Insert: {
          id?: string
          company_id?: string
          number?: number
          doc_date?: string
          warehouse_id?: string
          note?: string | null
          status?: string
          shortage_value?: number
          surplus_value?: number
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          updated_at?: string
          posted_at?: string | null
          posted_by?: string | null
          posted_by_name?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
        }
        Update: {
          id?: string
          company_id?: string
          number?: number
          doc_date?: string
          warehouse_id?: string
          note?: string | null
          status?: string
          shortage_value?: number
          surplus_value?: number
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          updated_at?: string
          posted_at?: string | null
          posted_by?: string | null
          posted_by_name?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
        }
        Relationships: []
      }
      prod_stock_count_items: {
        Row: {
          id: string
          company_id: string
          count_id: string
          item_id: string
          counted_qty: number
          system_qty: number | null
          diff_qty: number | null
          unit_cost: number | null
          diff_value: number | null
        }
        Insert: {
          id?: string
          company_id?: string
          count_id?: string
          item_id?: string
          counted_qty?: number
          system_qty?: number | null
          diff_qty?: number | null
          unit_cost?: number | null
          diff_value?: number | null
        }
        Update: {
          id?: string
          company_id?: string
          count_id?: string
          item_id?: string
          counted_qty?: number
          system_qty?: number | null
          diff_qty?: number | null
          unit_cost?: number | null
          diff_value?: number | null
        }
        Relationships: []
      }
      prod_openings: {
        Row: {
          id: string
          company_id: string
          number: number
          doc_date: string
          warehouse_id: string
          note: string | null
          total: number
          status: string
          created_by: string | null
          created_by_name: string | null
          created_at: string
          cancelled_at: string | null
          cancelled_by: string | null
        }
        Insert: {
          id?: string
          company_id?: string
          number?: number
          doc_date?: string
          warehouse_id?: string
          note?: string | null
          total?: number
          status?: string
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
        }
        Update: {
          id?: string
          company_id?: string
          number?: number
          doc_date?: string
          warehouse_id?: string
          note?: string | null
          total?: number
          status?: string
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
        }
        Relationships: []
      }
      prod_opening_items: {
        Row: {
          id: string
          company_id: string
          opening_id: string
          item_id: string
          lot_id: string
          sort_order: number
          qty: number
          unit_cost: number
          total: number
          fat_pct: number | null
          protein_pct: number | null
          expiry_date: string | null
          supplier_id: string | null
        }
        Insert: {
          id?: string
          company_id?: string
          opening_id?: string
          item_id?: string
          lot_id?: string
          sort_order?: number
          qty?: number
          unit_cost?: number
          total?: number
          fat_pct?: number | null
          protein_pct?: number | null
          expiry_date?: string | null
          supplier_id?: string | null
        }
        Update: {
          id?: string
          company_id?: string
          opening_id?: string
          item_id?: string
          lot_id?: string
          sort_order?: number
          qty?: number
          unit_cost?: number
          total?: number
          fat_pct?: number | null
          protein_pct?: number | null
          expiry_date?: string | null
          supplier_id?: string | null
        }
        Relationships: []
      }
      prod_price_corrections: {
        Row: {
          id: string
          company_id: string
          number: number
          doc_date: string
          receipt_id: string
          receipt_item_id: string
          item_id: string
          warehouse_id: string
          supplier_id: string | null
          qty: number
          old_price: number
          new_price: number
          debt_delta: number
          stock_qty: number
          stock_delta: number
          consumed_qty: number
          consumed_variance: number
          lots: Json
          note: string | null
          status: string
          created_by: string | null
          created_by_name: string | null
          created_at: string
          cancelled_at: string | null
          cancelled_by: string | null
          // Accounting (migration 20261110000018); undefined before it.
          vat_delta?: number
        }
        Insert: {
          id?: string
          company_id?: string
          number?: number
          doc_date?: string
          receipt_id?: string
          receipt_item_id?: string
          item_id?: string
          warehouse_id?: string
          supplier_id?: string | null
          qty?: number
          old_price?: number
          new_price?: number
          debt_delta?: number
          stock_qty?: number
          stock_delta?: number
          consumed_qty?: number
          consumed_variance?: number
          lots?: Json
          note?: string | null
          status?: string
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
        }
        Update: {
          id?: string
          company_id?: string
          number?: number
          doc_date?: string
          receipt_id?: string
          receipt_item_id?: string
          item_id?: string
          warehouse_id?: string
          supplier_id?: string | null
          qty?: number
          old_price?: number
          new_price?: number
          debt_delta?: number
          stock_qty?: number
          stock_delta?: number
          consumed_qty?: number
          consumed_variance?: number
          lots?: Json
          note?: string | null
          status?: string
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
        }
        Relationships: []
      }
      prod_recipe_versions: {
        Row: {
          id: string
          company_id: string
          recipe_id: string
          version: number
          output_item_id: string
          output_qty: number
          lines: Json
          is_active: boolean | null
          note: string | null
          saved_by: string | null
          saved_by_name: string | null
          saved_at: string
        }
        Insert: {
          id?: string
          company_id?: string
          recipe_id?: string
          version?: number
          output_item_id?: string
          output_qty?: number
          lines?: Json
          is_active?: boolean | null
          note?: string | null
          saved_by?: string | null
          saved_by_name?: string | null
          saved_at?: string
        }
        Update: {
          id?: string
          company_id?: string
          recipe_id?: string
          version?: number
          output_item_id?: string
          output_qty?: number
          lines?: Json
          is_active?: boolean | null
          note?: string | null
          saved_by?: string | null
          saved_by_name?: string | null
          saved_at?: string
        }
        Relationships: []
      }
      prod_separations: {
        Row: {
          id: string
          company_id: string
          number: number
          doc_date: string
          warehouse_id: string
          output_warehouse_id: string
          milk_item_id: string
          cream_item_id: string
          skim_item_id: string
          milk_qty: number
          milk_fat: number
          cream_fat: number
          skim_fat: number
          loss_pct: number
          cream_qty_calc: number
          skim_qty_calc: number
          cream_qty: number
          skim_qty: number
          loss_qty: number
          allocation_method: string
          skim_price: number | null
          cream_ref_price: number | null
          skim_ref_price: number | null
          milk_cost: number
          cream_unit_cost: number
          skim_unit_cost: number
          note: string | null
          status: string
          created_by: string | null
          created_by_name: string | null
          created_at: string
          cancelled_at: string | null
          cancelled_by: string | null
          // Controls (migration 20261110000017); undefined before it.
          lot_pick_deviation?: boolean
        }
        Insert: {
          id?: string
          company_id?: string
          number?: number
          doc_date?: string
          warehouse_id?: string
          output_warehouse_id?: string
          milk_item_id?: string
          cream_item_id?: string
          skim_item_id?: string
          milk_qty?: number
          milk_fat?: number
          cream_fat?: number
          skim_fat?: number
          loss_pct?: number
          cream_qty_calc?: number
          skim_qty_calc?: number
          cream_qty?: number
          skim_qty?: number
          loss_qty?: number
          allocation_method?: string
          skim_price?: number | null
          cream_ref_price?: number | null
          skim_ref_price?: number | null
          milk_cost?: number
          cream_unit_cost?: number
          skim_unit_cost?: number
          note?: string | null
          status?: string
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
        }
        Update: {
          id?: string
          company_id?: string
          number?: number
          doc_date?: string
          warehouse_id?: string
          output_warehouse_id?: string
          milk_item_id?: string
          cream_item_id?: string
          skim_item_id?: string
          milk_qty?: number
          milk_fat?: number
          cream_fat?: number
          skim_fat?: number
          loss_pct?: number
          cream_qty_calc?: number
          skim_qty_calc?: number
          cream_qty?: number
          skim_qty?: number
          loss_qty?: number
          allocation_method?: string
          skim_price?: number | null
          cream_ref_price?: number | null
          skim_ref_price?: number | null
          milk_cost?: number
          cream_unit_cost?: number
          skim_unit_cost?: number
          note?: string | null
          status?: string
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
        }
        Relationships: []
      }
      supply_agents: {
        Row: {
          id: string
          company_id: string
          name: string
          phone: string | null
          telegram_id: string | null
          is_active: boolean
          created_at: string
        }
        Insert: {
          id?: string
          company_id?: string
          name?: string
          phone?: string | null
          telegram_id?: string | null
          is_active?: boolean
          created_at?: string
        }
        Update: {
          id?: string
          company_id?: string
          name?: string
          phone?: string | null
          telegram_id?: string | null
          is_active?: boolean
          created_at?: string
        }
        Relationships: []
      }
      supply_cash_moves: {
        Row: {
          id: string
          company_id: string
          agent_id: string
          kind: string
          amount: number
          purpose: string | null
          expense_category_id: string | null
          move_date: string
          note: string | null
          created_by: string | null
          created_by_name: string | null
          created_at: string
          // Cash & bank (migration 20261110000016); undefined before it.
          account_id?: string | null
          // Controls (migration 20261110000017); undefined before it.
          status?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
          cancel_note?: string | null
        }
        Insert: {
          id?: string
          company_id?: string
          agent_id?: string
          kind?: string
          amount?: number
          purpose?: string | null
          expense_category_id?: string | null
          move_date?: string
          note?: string | null
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          account_id?: string | null
        }
        Update: {
          id?: string
          company_id?: string
          agent_id?: string
          kind?: string
          amount?: number
          purpose?: string | null
          expense_category_id?: string | null
          move_date?: string
          note?: string | null
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          account_id?: string | null
        }
        Relationships: []
      }
      // Accounting (migration 20261110000018_production_accounting.sql). RPC-only writes.
      prod_company_accounting: {
        Row: {
          company_id: string
          vat_payer: boolean
          base_currency: string
          overhead_method: string
          updated_at: string
          updated_by: string | null
        }
        Insert: { company_id?: string }
        Update: { company_id?: string }
        Relationships: []
      }
      prod_production_outputs: {
        Row: {
          id: string
          company_id: string
          production_id: string
          sort_order: number
          item_id: string
          warehouse_id: string
          qty: number
          share_pct: number
          ref_price: number | null
          cost: number
          unit_cost: number
          lot_id: string | null
        }
        Insert: { id?: string }
        Update: { id?: string }
        Relationships: []
      }
      prod_recipe_outputs: {
        Row: {
          id: string
          company_id: string
          recipe_id: string
          item_id: string
          qty_per_batch: number
          sort_order: number
        }
        Insert: { id?: string }
        Update: { id?: string }
        Relationships: []
      }
      prod_cost_pools: {
        Row: {
          id: string
          company_id: string
          period: string
          category: string
          amount: number
          expense_category_id: string | null
          note: string | null
          status: string
          created_by: string | null
          created_by_name: string | null
          created_at: string
          updated_at: string
          cancelled_at: string | null
          cancelled_by: string | null
        }
        Insert: { id?: string }
        Update: { id?: string }
        Relationships: []
      }
      prod_overhead_allocations: {
        Row: {
          id: string
          company_id: string
          period: string
          production_id: string
          output_id: string
          item_id: string
          method: string
          base: number
          amount: number
          pool_total: number
          created_by: string | null
          created_at: string
        }
        Insert: { id?: string }
        Update: { id?: string }
        Relationships: []
      }
      // Controls & audit (migration 20261110000017_production_controls.sql).
      prod_control_settings: {
        Row: {
          company_id: string
          production_tolerance_pct: number
          separation_loss_max_pct: number
          separation_fat_tolerance_pct: number
          processing_min_recovery_pct: number
          conditional_price_min_pct: number
          backdate_days_staff: number
          backdate_days_admin: number
          future_days: number
          lab_must_differ: boolean
          self_cancel_allowed: boolean
          supply_issue_daily_limit: number | null
          payment_over_debt_allowed: boolean
          manual_lot_pick_roles: string[]
          updated_at: string
          updated_by: string | null
        }
        Insert: { company_id?: string }
        Update: { company_id?: string }
        Relationships: []
      }
      prod_period_locks: {
        Row: {
          company_id: string
          locked_until: string | null
          locked_by: string | null
          locked_at: string | null
        }
        Insert: { company_id?: string; locked_until?: string | null; locked_by?: string | null; locked_at?: string | null }
        Update: { company_id?: string; locked_until?: string | null; locked_by?: string | null; locked_at?: string | null }
        Relationships: []
      }
      prod_audit_log: {
        Row: {
          id: string
          company_id: string
          at: string
          user_id: string | null
          user_name: string | null
          entity: string
          entity_id: string | null
          action: string
          old: Json | null
          new: Json | null
          rule: string | null
          note: string | null
        }
        Insert: { id?: string; company_id?: string }
        Update: { id?: string; company_id?: string }
        Relationships: []
      }
      // Cash & bank accounts (migration 20261110000016_production_cash.sql).
      prod_cash_accounts: {
        Row: {
          id: string
          company_id: string
          name: string
          kind: string
          currency: string
          bank_name: string | null
          account_no: string | null
          mfo: string | null
          opening_balance: number
          opening_date: string | null
          is_default_for: string[] | null
          is_active: boolean
          note: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          company_id?: string
          name?: string
          kind?: string
          currency?: string
          bank_name?: string | null
          account_no?: string | null
          mfo?: string | null
          opening_balance?: number
          opening_date?: string | null
          is_default_for?: string[] | null
          is_active?: boolean
          note?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          company_id?: string
          name?: string
          kind?: string
          currency?: string
          bank_name?: string | null
          account_no?: string | null
          mfo?: string | null
          opening_balance?: number
          opening_date?: string | null
          is_default_for?: string[] | null
          is_active?: boolean
          note?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      prod_cash_movements: {
        Row: {
          id: string
          company_id: string
          account_id: string
          move_date: string
          amount: number
          source_type: string
          source_id: string | null
          counterparty_type: string | null
          counterparty_id: string | null
          counterparty_name: string | null
          category_id: string | null
          note: string | null
          is_reversal: boolean
          created_by: string | null
          created_by_name: string | null
          created_at: string
        }
        Insert: {
          id?: string
          company_id?: string
          account_id?: string
          move_date?: string
          amount?: number
          source_type?: string
          source_id?: string | null
          counterparty_type?: string | null
          counterparty_id?: string | null
          counterparty_name?: string | null
          category_id?: string | null
          note?: string | null
          is_reversal?: boolean
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          company_id?: string
          account_id?: string
          move_date?: string
          amount?: number
          source_type?: string
          source_id?: string | null
          counterparty_type?: string | null
          counterparty_id?: string | null
          counterparty_name?: string | null
          category_id?: string | null
          note?: string | null
          is_reversal?: boolean
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
        }
        Relationships: []
      }
      prod_cash_orders: {
        Row: {
          id: string
          company_id: string
          number: number
          direction: string
          doc_date: string
          account_id: string
          amount: number
          category_id: string | null
          counterparty_name: string | null
          purpose: string | null
          note: string | null
          status: string
          created_by: string | null
          created_by_name: string | null
          created_at: string
          cancelled_at: string | null
          cancelled_by: string | null
        }
        Insert: {
          id?: string
          company_id?: string
          number?: number
          direction?: string
          doc_date?: string
          account_id?: string
          amount?: number
          category_id?: string | null
          counterparty_name?: string | null
          purpose?: string | null
          note?: string | null
          status?: string
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
        }
        Update: {
          id?: string
          company_id?: string
          number?: number
          direction?: string
          doc_date?: string
          account_id?: string
          amount?: number
          category_id?: string | null
          counterparty_name?: string | null
          purpose?: string | null
          note?: string | null
          status?: string
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
        }
        Relationships: []
      }
      prod_cash_transfers: {
        Row: {
          id: string
          company_id: string
          number: number
          doc_date: string
          from_account_id: string
          to_account_id: string
          amount: number
          note: string | null
          status: string
          created_by: string | null
          created_by_name: string | null
          created_at: string
          cancelled_at: string | null
          cancelled_by: string | null
        }
        Insert: {
          id?: string
          company_id?: string
          number?: number
          doc_date?: string
          from_account_id?: string
          to_account_id?: string
          amount?: number
          note?: string | null
          status?: string
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
        }
        Update: {
          id?: string
          company_id?: string
          number?: number
          doc_date?: string
          from_account_id?: string
          to_account_id?: string
          amount?: number
          note?: string | null
          status?: string
          created_by?: string | null
          created_by_name?: string | null
          created_at?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
        }
        Relationships: []
      }
      users: {
        Row: {
          branch_id: string | null
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
          branch_id?: string | null
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
          branch_id?: string | null
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
          branch_id: string
          company_id: string
          created_at: string
          id: string
          name: string
          type: string
        }
        Insert: {
          branch_id?: string
          company_id: string
          created_at?: string
          id?: string
          name: string
          type: string
        }
        Update: {
          branch_id?: string
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
      // Accounting (migration 20261110000018_production_accounting.sql).
      prod_vat_summary: {
        Row: {
          company_id: string | null
          month: string | null
          sales_vat: number | null
          returns_vat: number | null
          output_vat: number | null
          receipts_vat: number | null
          corrections_vat: number | null
          input_vat: number | null
          payable: number | null
        }
        Relationships: []
      }
      prod_product_costs_month: {
        Row: {
          company_id: string | null
          month: string | null
          item_id: string | null
          item_name: string | null
          item_unit: string | null
          qty: number | null
          material_cost: number | null
          overhead: number | null
          full_cost: number | null
          material_unit_cost: number | null
          full_unit_cost: number | null
        }
        Relationships: []
      }
      prod_cost_pool_suggestions: {
        Row: {
          company_id: string | null
          period: string | null
          expense_category_id: string | null
          category_name: string | null
          cash_amount: number | null
          supply_amount: number | null
          amount: number | null
          doc_count: number | null
          pooled: boolean | null
        }
        Relationships: []
      }
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
      prod_stock: {
        Row: {
          company_id: string | null
          warehouse_id: string | null
          item_id: string | null
          qty: number | null
          value: number | null
          avg_cost: number | null
        }
        Relationships: []
      }
      prod_stock_quality: {
        Row: {
          company_id: string | null
          warehouse_id: string | null
          item_id: string | null
          qty: number | null
          avg_fat: number | null
          avg_protein: number | null
        }
        Relationships: []
      }
      prod_lot_stock: {
        Row: {
          id: string | null
          company_id: string | null
          warehouse_id: string | null
          warehouse_name: string | null
          item_id: string | null
          item_name: string | null
          item_unit: string | null
          lot_no: string | null
          received_at: string | null
          opening_qty: number | null
          unit_cost: number | null
          fat_pct: number | null
          protein_pct: number | null
          supplier_id: string | null
          supplier_name: string | null
          source_doc_type: string | null
          source_doc_id: string | null
          origin_lot_id: string | null
          expiry_date: string | null
          is_opening: boolean | null
          created_at: string | null
          remaining_qty: number | null
          value: number | null
          hold_status: string | null
          hold_reason: string | null
          hold_at: string | null
          hold_by: string | null
        }
        Relationships: []
      }
      supply_agent_balances: {
        Row: {
          agent_id: string | null
          company_id: string | null
          issued: number | null
          returned: number | null
          spent: number | null
          balance: number | null
        }
        Relationships: []
      }
      // Wholesale sales views (migration 20261110000015).
      prod_item_prices: {
        Row: {
          price_list_id: string | null
          company_id: string | null
          price_list_name: string | null
          is_default: boolean | null
          is_active: boolean | null
          item_id: string | null
          item_name: string | null
          item_unit: string | null
          group_id: string | null
          item_is_active: boolean | null
          list_price: number | null
          default_price: number | null
          item_sale_price: number | null
          price: number | null
        }
        Relationships: []
      }
      // Cash & bank (migration 20261110000016).
      prod_cash_balances: {
        Row: {
          account_id: string | null
          company_id: string | null
          name: string | null
          kind: string | null
          currency: string | null
          bank_name: string | null
          account_no: string | null
          mfo: string | null
          is_default_for: string[] | null
          is_active: boolean | null
          note: string | null
          opening_balance: number | null
          opening_date: string | null
          total_in: number | null
          total_out: number | null
          balance: number | null
          last_move_at: string | null
          move_count: number | null
        }
        Relationships: []
      }
      prod_cash_movements_v: {
        Row: {
          id: string | null
          company_id: string | null
          account_id: string | null
          account_name: string | null
          account_kind: string | null
          move_date: string | null
          amount: number | null
          amount_in: number | null
          amount_out: number | null
          source_type: string | null
          source_id: string | null
          source_number: number | null
          source_status: string | null
          order_direction: string | null
          peer_account_id: string | null
          peer_account_name: string | null
          counterparty_type: string | null
          counterparty_id: string | null
          counterparty_name: string | null
          category_id: string | null
          category_name: string | null
          note: string | null
          is_reversal: boolean | null
          created_by: string | null
          created_by_name: string | null
          created_at: string | null
          running_balance: number | null
        }
        Relationships: []
      }
      prod_customer_balances: {
        Row: {
          customer_id: string | null
          company_id: string | null
          name: string | null
          sales_total: number | null
          returns_total: number | null
          payments_total: number | null
          balance: number | null
          last_sale_at: string | null
          last_payment_at: string | null
          credit_limit: number | null
        }
        Relationships: []
      }
      prod_customer_ageing: {
        Row: {
          customer_id: string | null
          company_id: string | null
          name: string | null
          balance: number | null
          not_due: number | null
          overdue_1_15: number | null
          overdue_16_30: number | null
          overdue_31_plus: number | null
        }
        Relationships: []
      }
      prod_sales_lines_v: {
        Row: {
          row_kind: string | null
          company_id: string | null
          sale_id: string | null
          sale_number: number | null
          return_id: string | null
          return_number: number | null
          sale_item_id: string | null
          doc_date: string | null
          customer_id: string | null
          customer_name: string | null
          warehouse_id: string | null
          item_id: string | null
          item_name: string | null
          item_unit: string | null
          group_id: string | null
          group_name: string | null
          qty: number | null
          price: number | null
          discount_pct: number | null
          amount: number | null
          vat_amount: number | null
          total: number | null
          cost: number | null
          margin: number | null
        }
        Relationships: []
      }
      prod_sale_item_returnable: {
        Row: {
          sale_item_id: string | null
          company_id: string | null
          sale_id: string | null
          item_id: string | null
          qty: number | null
          returned_qty: number | null
          returnable_qty: number | null
          returned_amount: number | null
          returnable_amount: number | null
        }
        Relationships: []
      }
      prod_supplier_ageing: {
        Row: {
          supplier_id: string | null
          company_id: string | null
          balance: number | null
          not_due: number | null
          overdue_1_15: number | null
          overdue_16_30: number | null
          overdue_31_plus: number | null
        }
        Relationships: []
      }
      prod_supplier_balances: {
        Row: {
          supplier_id: string | null
          company_id: string | null
          purchased: number | null
          paid: number | null
          debt: number | null
          last_receipt_at: string | null
          last_payment_at: string | null
        }
        Relationships: []
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
      get_business_type: { Args: never; Returns: string }
      assert_business_type: { Args: { p: string }; Returns: undefined }
      prod_save_item_group: {
        Args: { p_id: string | null; p_is_active: boolean; p_name: string }
        Returns: string
      }
      prod_save_item: { Args: { p_data: Json; p_id: string | null }; Returns: string }
      prod_save_warehouse: {
        Args: { p_id: string | null; p_is_active: boolean; p_name: string; p_storage_types: string[] }
        Returns: string
      }
      prod_create_receipt: { Args: { p_data: Json }; Returns: Json }
      prod_create_production: { Args: { p_data: Json }; Returns: Json }
      prod_create_processing: { Args: { p_data: Json }; Returns: Json }
      prod_create_transfer: { Args: { p_data: Json }; Returns: Json }
      prod_create_separation: { Args: { p_data: Json }; Returns: Json }
      prod_cancel_document: { Args: { p_doc_type: string; p_id: string }; Returns: undefined }
      supply_save_agent: {
        Args: { p_id: string | null; p_is_active: boolean; p_name: string; p_phone: string | null; p_telegram_id: string | null }
        Returns: string
      }
      supply_add_move: { Args: { p_data: Json }; Returns: string }
      prod_save_supplier: { Args: { p_data: Json; p_id: string | null }; Returns: string }
      prod_create_supplier_payment: { Args: { p_data: Json }; Returns: Json }
      prod_cancel_supplier_payment: { Args: { p_id: string }; Returns: undefined }
      prod_save_recipe: { Args: { p_data: Json; p_id: string | null }; Returns: string }
      prod_save_milk_settings: { Args: { p_data: Json }; Returns: undefined }
      prod_create_milk_intake: { Args: { p_data: Json }; Returns: Json }
      prod_record_milk_lab: { Args: { p_data: Json; p_id: string }; Returns: Json }
      prod_cancel_milk_intake: { Args: { p_id: string }; Returns: undefined }
      prod_create_writeoff: { Args: { p_data: Json }; Returns: Json }
      prod_save_stock_count: { Args: { p_data: Json; p_id: string | null }; Returns: string }
      // p_ctl: controls override (migration 20261110000017); omit it before that migration.
      prod_post_stock_count: { Args: { p_id: string; p_ctl?: Json | null }; Returns: Json }
      prod_delete_stock_count_draft: { Args: { p_id: string }; Returns: undefined }
      prod_create_opening: { Args: { p_data: Json }; Returns: Json }
      // Wholesale sales (migration 20261110000015).
      prod_save_customer: { Args: { p_data: Json; p_id: string | null }; Returns: string }
      prod_save_price_list: { Args: { p_data: Json; p_id: string | null }; Returns: string }
      prod_create_sale: { Args: { p_data: Json }; Returns: Json }
      prod_create_sale_return: { Args: { p_data: Json }; Returns: Json }
      prod_create_customer_payment: { Args: { p_data: Json }; Returns: Json }
      prod_cancel_customer_payment: { Args: { p_id: string }; Returns: undefined }
      // Cash & bank (migration 20261110000016).
      prod_save_cash_account: { Args: { p_data: Json; p_id: string | null }; Returns: string }
      prod_create_cash_order: { Args: { p_data: Json }; Returns: Json }
      prod_create_cash_transfer: { Args: { p_data: Json }; Returns: Json }
      prod_cancel_cash_doc: { Args: { p_id: string; p_type: string }; Returns: undefined }
      prod_create_price_correction: { Args: { p_data: Json }; Returns: Json }
      prod_set_lot_hold: { Args: { p_lot_id: string; p_reason: string | null; p_status: string }; Returns: undefined }
      prod_amend_milk_lab: { Args: { p_intake_id: string; p_lab: Json }; Returns: Json }
      // Controls (migration 20261110000017).
      prod_save_control_settings: { Args: { p_data: Json }; Returns: Json }
      // Accounting (migration 20261110000018).
      prod_save_accounting_settings: { Args: { p_data: Json }; Returns: Json }
      prod_save_recipe_outputs: { Args: { p_recipe_id: string; p_outputs: Json }; Returns: Json }
      prod_save_cost_pool: { Args: { p_id: string | null; p_data: Json }; Returns: Json }
      prod_cancel_cost_pool: { Args: { p_id: string }; Returns: Json }
      prod_allocate_overhead: { Args: { p_month: string; p_ctl?: Json | null }; Returns: Json }
      prod_pnl: { Args: { p_from: string; p_to: string; p_group?: string }; Returns: Json }
      prod_report_turnover: { Args: { p_from: string | null; p_to: string; p_warehouse?: string | null; p_group?: string | null }; Returns: Json }
      prod_report_dashboard: { Args: { p_from: string; p_to: string; p_group?: string }; Returns: Json }
      prod_report_sales: { Args: { p_from: string; p_to: string; p_by?: string }; Returns: Json }
      prod_close_period: { Args: { p_until: string }; Returns: Json }
      prod_reopen_period: { Args: { p_until: string | null; p_note: string }; Returns: Json }
      supply_cancel_move: { Args: { p_id: string; p_note: string | null }; Returns: undefined }
      prod_change_item_unit: { Args: { p_item_id: string; p_new_unit: string; p_factor: number; p_note: string | null }; Returns: string }
      branch_overview: {
        Args: never
        Returns: {
          address: string | null
          created_at: string
          id: string
          is_active: boolean
          is_default: boolean
          name: string
          phone: string | null
          user_count: number
          warehouse_count: number
        }[]
      }
      cancel_stock_count: { Args: { p_count_id: string }; Returns: undefined }
      complete_stock_count: {
        Args: { p_count_id: string; p_zero_uncounted?: boolean }
        Returns: undefined
      }
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
      create_department: { Args: { p_data: Json }; Returns: string }
      create_employee: { Args: { p_data: Json }; Returns: string }
      create_expense: { Args: { p_data: Json }; Returns: string }
      create_expense_category: { Args: { p_data: Json }; Returns: string }
      create_position: { Args: { p_data: Json }; Returns: string }
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
      create_reward_penalty_entry: { Args: { p_data: Json }; Returns: string }
      create_reward_penalty_type: { Args: { p_data: Json }; Returns: string }
      create_stock_transfer: {
        Args: {
          p_date?: string | null
          p_from_warehouse_id: string
          p_items: Json
          p_note?: string | null
          p_to_warehouse_id: string
        }
        Returns: string
      }
      create_supplier_return: {
        Args: {
          p_date?: string | null
          p_items: Json
          p_note?: string | null
          p_supplier_id: string
          p_warehouse_id: string
        }
        Returns: string
      }
      delete_supplier_return: { Args: { p_id: string }; Returns: undefined }
      create_supplier: { Args: { p_data: Json }; Returns: string }
      create_supplier_payment: {
        Args: {
          p_amount: number
          p_date?: string | null
          p_note?: string | null
          p_payment_method?: string
          p_supplier_id: string
        }
        Returns: string
      }
      delete_supplier: { Args: { p_id: string }; Returns: undefined }
      delete_supplier_payment: { Args: { p_id: string }; Returns: undefined }
      update_supplier: { Args: { p_data: Json; p_id: string }; Returns: undefined }
      create_stock_count: {
        Args: { p_note?: string | null; p_warehouse_id: string }
        Returns: string
      }
      create_branch: {
        Args: { p_address?: string | null; p_name: string; p_phone?: string | null }
        Returns: string
      }
      create_warehouse: {
        Args: { p_branch_id?: string | null; p_name: string; p_type: string }
        Returns: string
      }
      delete_branch: { Args: { p_id: string }; Returns: undefined }
      delete_department: { Args: { p_id: string }; Returns: undefined }
      delete_exchange_rate: { Args: { p_id: string }; Returns: undefined }
      delete_expense: { Args: { p_id: string }; Returns: undefined }
      delete_expense_category: { Args: { p_id: string }; Returns: undefined }
      delete_position: { Args: { p_id: string }; Returns: undefined }
      delete_product: { Args: { p_id: string }; Returns: undefined }
      delete_product_group: { Args: { p_id: string }; Returns: undefined }
      delete_promotion: { Args: { p_id: string }; Returns: undefined }
      delete_reward_penalty_type: { Args: { p_id: string }; Returns: undefined }
      delete_stock_count: { Args: { p_count_id: string }; Returns: undefined }
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
      get_murojat_messages: {
        Args: { p_request_id: string }
        Returns: {
          company_id: string
          customer_id: string | null
          id: string
          message: string
          request_id: string
          sender: string
          sent_at: string | null
          telegram_message_id: number | null
        }[]
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
      increment_stock_count_item: {
        Args: { p_count_id: string; p_delta?: number; p_product_size_id: string }
        Returns: number
      }
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
      send_murojat_reply: {
        Args: { p_message: string; p_request_id: string }
        Returns: {
          company_id: string
          customer_id: string | null
          id: string
          message: string
          request_id: string
          sender: string
          sent_at: string | null
          telegram_message_id: number | null
        }
      }
      save_price_list: {
        Args: { p_id: string | null; p_name: string; p_base: string; p_adjust_percent: number; p_rounding: number; p_is_active: boolean }
        Returns: string
      }
      delete_price_list: {
        Args: { p_id: string }
        Returns: undefined
      }
      set_price_list_item: {
        Args: { p_price_list_id: string; p_product_size_id: string; p_price: number | null }
        Returns: undefined
      }
      set_customer_price_list: {
        Args: { p_customer_id: string; p_price_list_id: string | null }
        Returns: undefined
      }
      price_list_price: {
        Args: { p_price_list_id: string; p_product_size_id: string }
        Returns: number
      }
      set_gift_settings: {
        Args: { p_max_gift_percent: number; p_gift_staff_allowed: boolean }
        Returns: undefined
      }
      set_customer_vip: {
        Args: { p_customer_id: string; p_vip_discount_percent: number | null }
        Returns: undefined
      }
      set_exchange_rate: {
        Args: {
          p_currency?: string
          p_date: string
          p_rate: number
          p_source?: string
        }
        Returns: string
      }
      set_product_size_barcode: {
        Args: { p_barcode: string; p_id: string }
        Returns: undefined
      }
      set_stock_count_item: {
        Args: {
          p_count_id: string
          p_counted_qty: number | null
          p_product_size_id: string
        }
        Returns: undefined
      }
      stock_in: { Args: { p_entries: Json }; Returns: undefined }
      stock_out: {
        Args: { p_entries: Json; p_entry_type: string }
        Returns: undefined
      }
      update_department: {
        Args: { p_data: Json; p_id: string }
        Returns: undefined
      }
      update_position: {
        Args: { p_data: Json; p_id: string }
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
      update_request: {
        Args: { p_data: Json; p_id: string }
        Returns: undefined
      }
      update_reward_penalty_type: {
        Args: { p_data: Json; p_id: string }
        Returns: undefined
      }
      set_branch_active: {
        Args: { p_active: boolean; p_id: string }
        Returns: undefined
      }
      set_default_branch: { Args: { p_id: string }; Returns: undefined }
      update_branch: {
        Args: { p_address?: string | null; p_id: string; p_name: string; p_phone?: string | null }
        Returns: undefined
      }
      update_warehouse: {
        Args: { p_id: string; p_name: string; p_type: string; p_branch_id?: string | null }
        Returns: undefined
      }
      use_cashback: {
        Args: { p_balls: number; p_customer_id: string; p_transaction_id?: string | null }
        Returns: number
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
