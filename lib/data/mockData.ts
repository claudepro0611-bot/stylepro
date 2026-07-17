import type { Customer, Product, Transaction, Invoice, StockInEntry, StockOutEntry, Campaign, Coupon, Request, ProductGroup, Department, Position, Employee, RewardPenaltyTypeDef, RewardPenaltyEntry } from '@/lib/types'

// ─── Customers (50) ────────────────────────────────────────────────────────

export const mockCustomers: Customer[] = [
  // VIP (10)
  { id: 'C001', fullName: 'Jasur Toshmatov', phone: '+998901234567', email: 'jasur.toshmatov@gmail.com', address: 'Toshkent, Yunusobod tumani', status: 'VIP', totalPurchases: 12500000, lastPurchaseDate: '2026-06-01', createdAt: '2024-01-15', purchases: [], complaints: [] },
  { id: 'C002', fullName: 'Nilufar Karimova', phone: '+998911234568', email: 'nilufar.karimova@gmail.com', address: 'Toshkent, Chilonzor tumani', status: 'VIP', totalPurchases: 9800000, lastPurchaseDate: '2026-05-28', createdAt: '2024-02-10', purchases: [], complaints: [] },
  { id: 'C003', fullName: 'Bobur Xasanov', phone: '+998901234569', email: 'bobur.xasanov@mail.ru', address: 'Samarqand, Registon yaqini', status: 'VIP', totalPurchases: 15200000, lastPurchaseDate: '2026-06-03', createdAt: '2023-11-20', purchases: [], complaints: [] },
  { id: 'C004', fullName: 'Zulfiya Mirzayeva', phone: '+998931234570', email: 'zulfiya92@inbox.uz', address: 'Toshkent, Mirzo Ulugbek tumani', status: 'VIP', totalPurchases: 7600000, lastPurchaseDate: '2026-05-25', createdAt: '2024-03-05', purchases: [], complaints: [] },
  { id: 'C005', fullName: 'Sardor Rahimov', phone: '+998941234571', email: 'sardor.rahimov@gmail.com', address: 'Farg\'ona, Markaziy ko\'cha', status: 'VIP', totalPurchases: 11300000, lastPurchaseDate: '2026-06-02', createdAt: '2023-12-01', purchases: [], complaints: [] },
  { id: 'C006', fullName: 'Feruza Yusupova', phone: '+998951234572', email: 'feruza.yusupova@mail.ru', address: 'Namangan, Uychi ko\'cha', status: 'VIP', totalPurchases: 8400000, lastPurchaseDate: '2026-05-30', createdAt: '2024-01-22', purchases: [], complaints: [] },
  { id: 'C007', fullName: 'Ulugbek Abdullayev', phone: '+998901234573', email: 'ulugbek.abdullayev@gmail.com', address: 'Toshkent, Shayxontohur tumani', status: 'VIP', totalPurchases: 13700000, lastPurchaseDate: '2026-06-04', createdAt: '2023-10-15', purchases: [], complaints: [] },
  { id: 'C008', fullName: 'Shahlo Ergasheva', phone: '+998911234574', email: 'shahlo.ergasheva@inbox.uz', address: 'Andijon, Asaka ko\'cha', status: 'VIP', totalPurchases: 6900000, lastPurchaseDate: '2026-05-22', createdAt: '2024-04-01', purchases: [], complaints: [] },
  { id: 'C009', fullName: 'Shohruh Nazarov', phone: '+998901234575', email: 'shohruh.nazarov@gmail.com', address: 'Buxoro, Eski shahar', status: 'VIP', totalPurchases: 10100000, lastPurchaseDate: '2026-06-01', createdAt: '2024-02-28', purchases: [], complaints: [] },
  { id: 'C010', fullName: 'Malika Qodirova', phone: '+998931234576', email: 'malika.qodirova@mail.ru', address: 'Toshkent, Uchtepa tumani', status: 'VIP', totalPurchases: 8800000, lastPurchaseDate: '2026-05-29', createdAt: '2024-01-10', purchases: [], complaints: [] },

  // Regular (30)
  { id: 'C011', fullName: 'Doniyor Sobirov', phone: '+998901234577', email: 'doniyor.sobirov@gmail.com', address: 'Toshkent, Bektemir tumani', status: 'Regular', totalPurchases: 2100000, lastPurchaseDate: '2026-05-20', createdAt: '2024-05-10', purchases: [], complaints: [] },
  { id: 'C012', fullName: 'Dilnoza Hamidova', phone: '+998941234578', email: 'dilnoza92@inbox.uz', address: 'Qarshi, Markaziy ko\'cha', status: 'Regular', totalPurchases: 1800000, lastPurchaseDate: '2026-05-15', createdAt: '2024-06-01', purchases: [], complaints: [] },
  { id: 'C013', fullName: 'Sanjar Ismoilov', phone: '+998951234579', email: 'sanjar.ismoilov@mail.ru', address: 'Toshkent, Yakkasaroy tumani', status: 'Regular', totalPurchases: 2500000, lastPurchaseDate: '2026-05-18', createdAt: '2024-04-15', purchases: [], complaints: [] },
  { id: 'C014', fullName: 'Nafisa Olimova', phone: '+998901234580', email: 'nafisa.olimova@gmail.com', address: 'Namangan, Markaziy ko\'cha', status: 'Regular', totalPurchases: 1600000, lastPurchaseDate: '2026-05-10', createdAt: '2024-07-01', purchases: [], complaints: [] },
  { id: 'C015', fullName: 'Jahongir Ibrohimov', phone: '+998911234581', email: 'jahongir.ibrohimov@gmail.com', address: 'Samarqand, Amir Temur ko\'cha', status: 'Regular', totalPurchases: 2900000, lastPurchaseDate: '2026-06-01', createdAt: '2024-03-20', purchases: [], complaints: [] },
  { id: 'C016', fullName: 'Nargiza Normatova', phone: '+998931234582', email: 'nargiza.normatova@inbox.uz', address: 'Toshkent, Olmazor tumani', status: 'Regular', totalPurchases: 1200000, lastPurchaseDate: '2026-04-28', createdAt: '2024-08-05', purchases: [], complaints: [] },
  { id: 'C017', fullName: 'Timur Tursunov', phone: '+998901234583', email: 'timur.tursunov@mail.ru', address: 'Farg\'ona, Fergana shahri', status: 'Regular', totalPurchases: 2300000, lastPurchaseDate: '2026-05-22', createdAt: '2024-05-25', purchases: [], complaints: [] },
  { id: 'C018', fullName: 'Muazzam Qosimova', phone: '+998941234584', email: 'muazzam.qosimova@gmail.com', address: 'Andijon, Shahricha ko\'cha', status: 'Regular', totalPurchases: 1900000, lastPurchaseDate: '2026-05-17', createdAt: '2024-06-15', purchases: [], complaints: [] },
  { id: 'C019', fullName: 'Behruz Mamadaliyev', phone: '+998951234585', email: 'behruz.mamadaliyev@gmail.com', address: 'Toshkent, Yashnobod tumani', status: 'Regular', totalPurchases: 2700000, lastPurchaseDate: '2026-05-30', createdAt: '2024-04-01', purchases: [], complaints: [] },
  { id: 'C020', fullName: 'Mohira Xolmatova', phone: '+998901234586', email: 'mohira.xolmatova@inbox.uz', address: 'Buxoro, Navoi ko\'cha', status: 'Regular', totalPurchases: 1500000, lastPurchaseDate: '2026-05-12', createdAt: '2024-07-20', purchases: [], complaints: [] },
  { id: 'C021', fullName: 'Mansur Tojimatov', phone: '+998911234587', email: 'mansur.tojimatov@mail.ru', address: 'Toshkent, Sergeli tumani', status: 'Regular', totalPurchases: 2100000, lastPurchaseDate: '2026-05-25', createdAt: '2024-05-10', purchases: [], complaints: [] },
  { id: 'C022', fullName: 'Lobar Rajabova', phone: '+998931234588', email: 'lobar.rajabova@gmail.com', address: 'Qarshi, Yangi hayot ko\'cha', status: 'Regular', totalPurchases: 1700000, lastPurchaseDate: '2026-05-08', createdAt: '2024-08-01', purchases: [], complaints: [] },
  { id: 'C023', fullName: 'Eldor Saidov', phone: '+998901234589', email: 'eldor.saidov@gmail.com', address: 'Toshkent, Mirabad tumani', status: 'Regular', totalPurchases: 2400000, lastPurchaseDate: '2026-05-28', createdAt: '2024-06-05', purchases: [], complaints: [] },
  { id: 'C024', fullName: 'Kamola Askarova', phone: '+998941234590', email: 'kamola.askarova@inbox.uz', address: 'Namangan, Uychi ko\'cha', status: 'Regular', totalPurchases: 1300000, lastPurchaseDate: '2026-04-20', createdAt: '2024-09-01', purchases: [], complaints: [] },
  { id: 'C025', fullName: 'Rustam Xudoyberdiyev', phone: '+998951234591', email: 'rustam.x@mail.ru', address: 'Samarqand, Ko\'k sariqcha', status: 'Regular', totalPurchases: 2600000, lastPurchaseDate: '2026-06-02', createdAt: '2024-04-25', purchases: [], complaints: [] },
  { id: 'C026', fullName: 'Sabina Karimova', phone: '+998901234592', email: 'sabina.karimova@gmail.com', address: 'Toshkent, Yunus-Abad', status: 'Regular', totalPurchases: 1800000, lastPurchaseDate: '2026-05-14', createdAt: '2024-07-10', purchases: [], complaints: [] },
  { id: 'C027', fullName: 'Zafar Toshmatov', phone: '+998911234593', email: 'zafar.toshmatov@mail.ru', address: 'Farg\'ona, Eski ko\'cha', status: 'Regular', totalPurchases: 2200000, lastPurchaseDate: '2026-05-20', createdAt: '2024-05-15', purchases: [], complaints: [] },
  { id: 'C028', fullName: 'Gulnora Mirzayeva', phone: '+998931234594', email: 'gulnora.mirzayeva@gmail.com', address: 'Andijon, Markaz ko\'cha', status: 'Regular', totalPurchases: 1600000, lastPurchaseDate: '2026-05-05', createdAt: '2024-08-20', purchases: [], complaints: [] },
  { id: 'C029', fullName: 'Mirzo Rahimov', phone: '+998901234595', email: 'mirzo.rahimov@inbox.uz', address: 'Toshkent, Qorasaroy', status: 'Regular', totalPurchases: 2800000, lastPurchaseDate: '2026-06-03', createdAt: '2024-04-10', purchases: [], complaints: [] },
  { id: 'C030', fullName: 'Ozoda Yusupova', phone: '+998941234596', email: 'ozoda.yusupova@gmail.com', address: 'Buxoro, Ark yaqini', status: 'Regular', totalPurchases: 1400000, lastPurchaseDate: '2026-04-25', createdAt: '2024-09-05', purchases: [], complaints: [] },
  { id: 'C031', fullName: 'Oybek Abdullayev', phone: '+998951234597', email: 'oybek.abdullayev@mail.ru', address: 'Toshkent, Shayxontohur', status: 'Regular', totalPurchases: 2000000, lastPurchaseDate: '2026-05-22', createdAt: '2024-06-20', purchases: [], complaints: [] },
  { id: 'C032', fullName: 'Sarvinoz Ergasheva', phone: '+998901234598', email: 'sarvinoz.ergasheva@gmail.com', address: 'Namangan, Yangiyo\'l', status: 'Regular', totalPurchases: 1750000, lastPurchaseDate: '2026-05-16', createdAt: '2024-07-15', purchases: [], complaints: [] },
  { id: 'C033', fullName: 'Lochin Nazarov', phone: '+998911234599', email: 'lochin.nazarov@inbox.uz', address: 'Toshkent, Chilonzor', status: 'Regular', totalPurchases: 2350000, lastPurchaseDate: '2026-05-27', createdAt: '2024-05-05', purchases: [], complaints: [] },
  { id: 'C034', fullName: 'Dildora Qodirova', phone: '+998931234600', email: 'dildora.qodirova@gmail.com', address: 'Samarqand, Shahrisabz yo\'li', status: 'Regular', totalPurchases: 1550000, lastPurchaseDate: '2026-05-10', createdAt: '2024-08-10', purchases: [], complaints: [] },
  { id: 'C035', fullName: 'Husayn Sobirov', phone: '+998901234601', email: 'husayn.sobirov@mail.ru', address: 'Toshkent, Uchtepa', status: 'Regular', totalPurchases: 2650000, lastPurchaseDate: '2026-06-01', createdAt: '2024-04-20', purchases: [], complaints: [] },
  { id: 'C036', fullName: 'Gulsanam Hamidova', phone: '+998941234602', email: 'gulsanam.hamidova@gmail.com', address: 'Farg\'ona, Qo\'qon yo\'li', status: 'Regular', totalPurchases: 1850000, lastPurchaseDate: '2026-05-18', createdAt: '2024-06-25', purchases: [], complaints: [] },
  { id: 'C037', fullName: 'Kamol Ismoilov', phone: '+998951234603', email: 'kamol.ismoilov@inbox.uz', address: 'Andijon, Yunusobod ko\'cha', status: 'Regular', totalPurchases: 2050000, lastPurchaseDate: '2026-05-24', createdAt: '2024-07-05', purchases: [], complaints: [] },
  { id: 'C038', fullName: 'Maftuna Olimova', phone: '+998901234604', email: 'maftuna.olimova@gmail.com', address: 'Toshkent, Mirzo Ulugbek', status: 'Regular', totalPurchases: 1450000, lastPurchaseDate: '2026-05-06', createdAt: '2024-09-10', purchases: [], complaints: [] },
  { id: 'C039', fullName: 'Baxtiyor Ibrohimov', phone: '+998911234605', email: 'baxtiyor.ibrohimov@mail.ru', address: 'Toshkent, Olmazor', status: 'Regular', totalPurchases: 2750000, lastPurchaseDate: '2026-06-04', createdAt: '2024-04-05', purchases: [], complaints: [] },
  { id: 'C040', fullName: 'Sitora Normatova', phone: '+998931234606', email: 'sitora.normatova@gmail.com', address: 'Qarshi, Nishon ko\'cha', status: 'Regular', totalPurchases: 1650000, lastPurchaseDate: '2026-05-13', createdAt: '2024-08-15', purchases: [], complaints: [] },

  // New (10)
  { id: 'C041', fullName: 'Alisher Tursunov', phone: '+998901234607', email: 'alisher.tursunov@gmail.com', address: 'Toshkent, Bektemir', status: 'New', totalPurchases: 250000, lastPurchaseDate: '2026-05-28', createdAt: '2026-04-15', purchases: [], complaints: [] },
  { id: 'C042', fullName: 'Dilorom Qosimova', phone: '+998941234608', email: 'dilorom.qosimova@inbox.uz', address: 'Namangan, G\'oz yo\'li', status: 'New', totalPurchases: 180000, lastPurchaseDate: '2026-05-20', createdAt: '2026-04-22', purchases: [], complaints: [] },
  { id: 'C043', fullName: 'Nodir Mamadaliyev', phone: '+998951234609', email: 'nodir.mamadaliyev@mail.ru', address: 'Samarqand, Registon', status: 'New', totalPurchases: 320000, lastPurchaseDate: '2026-06-01', createdAt: '2026-05-01', purchases: [], complaints: [] },
  { id: 'C044', fullName: 'Munira Xolmatova', phone: '+998901234610', email: 'munira.xolmatova@gmail.com', address: 'Toshkent, Yashnobod', status: 'New', totalPurchases: 150000, lastPurchaseDate: '2026-05-15', createdAt: '2026-04-30', purchases: [], complaints: [] },
  { id: 'C045', fullName: 'Murod Tojimatov', phone: '+998911234611', email: 'murod.tojimatov@gmail.com', address: 'Farg\'ona, Qo\'qon', status: 'New', totalPurchases: 280000, lastPurchaseDate: '2026-05-25', createdAt: '2026-05-05', purchases: [], complaints: [] },
  { id: 'C046', fullName: 'Hulkar Rajabova', phone: '+998931234612', email: 'hulkar.rajabova@inbox.uz', address: 'Andijon, Arxon ko\'cha', status: 'New', totalPurchases: 120000, lastPurchaseDate: '2026-05-10', createdAt: '2026-05-08', purchases: [], complaints: [] },
  { id: 'C047', fullName: 'Hamid Saidov', phone: '+998901234613', email: 'hamid.saidov@mail.ru', address: 'Toshkent, Sergeli', status: 'New', totalPurchases: 350000, lastPurchaseDate: '2026-06-03', createdAt: '2026-04-18', purchases: [], complaints: [] },
  { id: 'C048', fullName: 'Barno Askarova', phone: '+998941234614', email: 'barno.askarova@gmail.com', address: 'Buxoro, Ko\'hna shahar', status: 'New', totalPurchases: 200000, lastPurchaseDate: '2026-05-18', createdAt: '2026-05-10', purchases: [], complaints: [] },
  { id: 'C049', fullName: 'Ravshan Xudoyberdiyev', phone: '+998951234615', email: 'ravshan.x@gmail.com', address: 'Toshkent, Mirabad', status: 'New', totalPurchases: 90000, lastPurchaseDate: '2026-05-05', createdAt: '2026-05-15', purchases: [], complaints: [] },
  { id: 'C050', fullName: 'Nafosa Karimova', phone: '+998901234616', email: 'nafosa.karimova@inbox.uz', address: 'Namangan, Uychi', status: 'New', totalPurchases: 0, lastPurchaseDate: '', createdAt: '2026-05-28', purchases: [], complaints: [] },
]

// ─── Products (30) ─────────────────────────────────────────────────────────

export const mockProducts: Product[] = [
  // Ko'ylak (5)
  { id: 'P001', name: "Ko'k Klassik Ko'ylak", sku: 'KOY-001', category: "Ko'ylak", price: 150000, description: "Erkaklar uchun ko'k rangli klassik ko'ylak, 100% paxta.", colors: ["Ko'k", 'Oq'], minStock: 10, imageUrl: '', status: 'active', warehouseId: '' },
  { id: 'P002', name: "Oq Yozgi Ko'ylak", sku: 'KOY-002', category: "Ko'ylak", price: 85000, description: "Ayollar uchun oq rangli yozgi ko'ylak, nafis bezaklar bilan.", colors: ['Oq', 'Sariq'], minStock: 10, imageUrl: '', status: 'active', warehouseId: '' },
  { id: 'P003', name: "Qora Biznes Ko'ylak", sku: 'KOY-003', category: "Ko'ylak", price: 200000, description: "Erkaklar uchun qora rangli biznes ko'ylak, ingichka to'qima.", colors: ['Qora', 'Kulrang'], minStock: 8, imageUrl: '', status: 'active', warehouseId: '' },
  { id: 'P004', name: "Qizil Chizma Ko'ylak", sku: 'KOY-004', category: "Ko'ylak", price: 120000, description: "Ayollar uchun qizil rangli chizma ko'ylak.", colors: ['Qizil', 'Pushti'], minStock: 5, imageUrl: '', status: 'active', warehouseId: '' },
  { id: 'P005', name: "Kulrang Casual Ko'ylak", sku: 'KOY-005', category: "Ko'ylak", price: 95000, description: "Kundalik foydalanish uchun kulrang ko'ylak.", colors: ['Kulrang', "Ko'k"], minStock: 10, imageUrl: '', status: 'active', warehouseId: '' },

  // Shim (4)
  { id: 'P006', name: "Qora Klassik Shim", sku: 'SHM-001', category: 'Shim', price: 280000, description: "Erkaklar uchun qora klassik shim, to'g'ri qirqim.", colors: ['Qora', 'Kulrang'], minStock: 8, imageUrl: '', status: 'active', warehouseId: '' },
  { id: 'P007', name: "Ko'k Jins Shim", sku: 'SHM-002', category: 'Shim', price: 320000, description: "Zamona jins shim, qulay va chiroyli.", colors: ["Ko'k", 'Qora'], minStock: 8, imageUrl: '', status: 'active', warehouseId: '' },
  { id: 'P008', name: "Bej Sport Shim", sku: 'SHM-003', category: 'Shim', price: 195000, description: "Sport uchun qulay bej rangli shim.", colors: ['Bej', 'Qora'], minStock: 5, imageUrl: '', status: 'active', warehouseId: '' },
  { id: 'P009', name: "Kulrang Biznes Shim", sku: 'SHM-004', category: 'Shim', price: 350000, description: "Rasmiy uchrashuvlar uchun kulrang shim.", colors: ['Kulrang', 'Qora'], minStock: 5, imageUrl: '', status: 'active', warehouseId: '' },

  // Ko'nglak (4)
  { id: 'P010', name: "Yashil Sport Ko'nglak", sku: 'KNG-001', category: "Ko'nglak", price: 180000, description: "Sport mashg'ulotlari uchun yashil ko'nglak.", colors: ['Yashil', 'Qora'], minStock: 8, imageUrl: '', status: 'active', warehouseId: '' },
  { id: 'P011', name: "Qora Slim Ko'nglak", sku: 'KNG-002', category: "Ko'nglak", price: 220000, description: "Slim fit qora ko'nglak, zamonaviy dizayn.", colors: ['Qora', 'Kulrang'], minStock: 8, imageUrl: '', status: 'active', warehouseId: '' },
  { id: 'P012', name: "Oq Klassik Ko'nglak", sku: 'KNG-003', category: "Ko'nglak", price: 160000, description: "Erkaklar uchun oq klassik ko'nglak.", colors: ['Oq', "Ko'k"], minStock: 10, imageUrl: '', status: 'active', warehouseId: '' },
  { id: 'P013', name: "Ko'k Stripe Ko'nglak", sku: 'KNG-004', category: "Ko'nglak", price: 195000, description: "Ko'k rangli chiziqli ko'nglak.", colors: ["Ko'k", 'Oq'], minStock: 6, imageUrl: '', status: 'active', warehouseId: '' },

  // Kurtka (4)
  { id: 'P014', name: "Qora Charm Kurtka", sku: 'KRT-001', category: 'Kurtka', price: 650000, description: "Yuqori sifatli charm kurtka, qishki uchun ideal.", colors: ['Qora', 'Jigarrang'], minStock: 4, imageUrl: '', status: 'active', warehouseId: '' },
  { id: 'P015', name: "Ko'k Denim Kurtka", sku: 'KRT-002', category: 'Kurtka', price: 380000, description: "Klassik ko'k denim kurtka, har qanday stil uchun.", colors: ["Ko'k", 'Kulrang'], minStock: 5, imageUrl: '', status: 'active', warehouseId: '' },
  { id: 'P016', name: "Yashil Harbiy Kurtka", sku: 'KRT-003', category: 'Kurtka', price: 450000, description: "Harbiy uslubdagi yashil kurtka.", colors: ['Yashil', 'Qora'], minStock: 5, imageUrl: '', status: 'active', warehouseId: '' },
  { id: 'P017', name: "Qizil Puf Kurtka", sku: 'KRT-004', category: 'Kurtka', price: 520000, description: "Issiq va yengil qizil puf kurtka.", colors: ['Qizil', 'Qora'], minStock: 5, imageUrl: '', status: 'active', warehouseId: '' },

  // Palto (3)
  { id: 'P018', name: "Kulrang Erkaklar Paltosi", sku: 'PLT-001', category: 'Palto', price: 850000, description: "Uzun kulrang palto, qish mavsumi uchun.", colors: ['Kulrang', 'Qora'], minStock: 3, imageUrl: '', status: 'active', warehouseId: '' },
  { id: 'P019', name: "Bej Ayollar Paltosi", sku: 'PLT-002', category: 'Palto', price: 780000, description: "Nafis bej rangli ayollar paltosi.", colors: ['Bej', 'Kulrang'], minStock: 3, imageUrl: '', status: 'active', warehouseId: '' },
  { id: 'P020', name: "Qora Klasik Palto", sku: 'PLT-003', category: 'Palto', price: 920000, description: "Timeless qora palto, premium material.", colors: ['Qora'], minStock: 3, imageUrl: '', status: 'active', warehouseId: '' },

  // Yubka (4)
  { id: 'P021', name: "Qizil Mini Yubka", sku: 'YBK-001', category: 'Yubka', price: 90000, description: "Yorqin qizil mini yubka, yoz mavsumi uchun.", colors: ['Qizil', 'Pushti'], minStock: 8, imageUrl: '', status: 'active', warehouseId: '' },
  { id: 'P022', name: "Qora Midi Yubka", sku: 'YBK-002', category: 'Yubka', price: 140000, description: "Klassik qora midi yubka, ofis uchun mos.", colors: ['Qora', 'Kulrang'], minStock: 8, imageUrl: '', status: 'active', warehouseId: '' },
  { id: 'P023', name: "Ko'k Yozgi Yubka", sku: 'YBK-003', category: 'Yubka', price: 80000, description: "Engil ko'k yozgi yubka.", colors: ["Ko'k", 'Oq'], minStock: 8, imageUrl: '', status: 'active', warehouseId: '' },
  { id: 'P024', name: "Sariq Chiziqli Yubka", sku: 'YBK-004', category: 'Yubka', price: 110000, description: "Sariq rangli chiziqli maxi yubka.", colors: ['Sariq', 'Oq'], minStock: 5, imageUrl: '', status: 'active', warehouseId: '' },

  // Libos (3)
  { id: 'P025', name: "Qora Kechki Libos", sku: 'LBS-001', category: 'Libos', price: 400000, description: "Tantanali kechqurunlar uchun qora libos.", colors: ['Qora'], minStock: 4, imageUrl: '', status: 'active', warehouseId: '' },
  { id: 'P026', name: "Oq To'y Libosi", sku: 'LBS-002', category: 'Libos', price: 650000, description: "Nozik oq to'y libosi, premium to'qima.", colors: ['Oq', 'Krем'], minStock: 3, imageUrl: '', status: 'active', warehouseId: '' },
  { id: 'P027', name: "Ko'k Kundalik Libos", sku: 'LBS-003', category: 'Libos', price: 220000, description: "Qulay ko'k kundalik libos.", colors: ["Ko'k", 'Yashil'], minStock: 5, imageUrl: '', status: 'active', warehouseId: '' },

  // Aksessuar (3)
  { id: 'P028', name: "Charm Kamar", sku: 'AKS-001', category: 'Aksessuar', price: 65000, description: "Yuqori sifatli charm kamar.", colors: ['Qora', 'Jigarrang'], minStock: 15, imageUrl: '', status: 'active', warehouseId: '' },
  { id: 'P029', name: "Ipak Galstuk", sku: 'AKS-002', category: 'Aksessuar', price: 45000, description: "Erkaklar uchun ipak galstuk.", colors: ['Qora', 'Ko\'k', 'Qizil'], minStock: 20, imageUrl: '', status: 'active', warehouseId: '' },
  { id: 'P030', name: "Yung Sharf", sku: 'AKS-003', category: 'Aksessuar', price: 80000, description: "Issiq yung sharf, qish mavsumi uchun.", colors: ['Kulrang', 'Qizil', "Ko'k"], minStock: 10, imageUrl: '', status: 'inactive', warehouseId: '' },
]

// ─── Helpers ───────────────────────────────────────────────────────────────

const PAYMENT_METHODS = ['Naqd', 'Karta', 'Click', 'Payme'] as const

function addDays(base: string, days: number): string {
  const d = new Date(base)
  d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0]
}

// ─── Transactions (200) ────────────────────────────────────────────────────

function generateTransactions(): Transaction[] {
  const txns: Transaction[] = []
  const startDate = '2026-03-06'

  for (let i = 0; i < 200; i++) {
    const dayOffset = Math.floor((i / 200) * 92)
    const custIdx = (i * 3 + 7) % 50
    const prodIdx = (i * 7 + 3) % 30
    const qty = (i % 3) + 1
    const customer = mockCustomers[custIdx]
    const product = mockProducts[prodIdx]
    const statusVal = i % 25 === 0 ? 'pending' : i % 60 === 0 ? 'cancelled' : 'completed'

    txns.push({
      id: `TXN-${String(i + 1).padStart(4, '0')}`,
      customerId: customer.id,
      customerName: customer.fullName,
      products: [{ productId: product.id, productName: product.name, quantity: qty, price: product.price }],
      totalAmount: product.price * qty,
      date: addDays(startDate, dayOffset),
      paymentMethod: PAYMENT_METHODS[i % 4],
      invoiceId: `INV-${String(Math.floor(i / 10) + 1).padStart(4, '0')}`,
      status: statusVal,
    })
  }
  return txns
}

export const mockTransactions: Transaction[] = generateTransactions()

// ─── Invoices (20) ─────────────────────────────────────────────────────────

export const mockInvoices: Invoice[] = [
  { id: 'INV-0001', customerId: 'C001', customerName: 'Jasur Toshmatov', items: [{ productId: 'P001', productName: "Ko'k Klassik Ko'ylak", quantity: 2, price: 150000, total: 300000 }, { productId: 'P006', productName: 'Qora Klassik Shim', quantity: 1, price: 280000, total: 280000 }], subtotal: 580000, discount: 58000, total: 522000, status: 'paid', createdAt: '2026-03-10', dueDate: '2026-03-25' },
  { id: 'INV-0002', customerId: 'C002', customerName: 'Nilufar Karimova', items: [{ productId: 'P021', productName: 'Qizil Mini Yubka', quantity: 2, price: 90000, total: 180000 }, { productId: 'P027', productName: "Ko'k Kundalik Libos", quantity: 1, price: 220000, total: 220000 }], subtotal: 400000, discount: 0, total: 400000, status: 'paid', createdAt: '2026-03-15', dueDate: '2026-03-30' },
  { id: 'INV-0003', customerId: 'C003', customerName: 'Bobur Xasanov', items: [{ productId: 'P014', productName: 'Qora Charm Kurtka', quantity: 1, price: 650000, total: 650000 }], subtotal: 650000, discount: 65000, total: 585000, status: 'paid', createdAt: '2026-03-20', dueDate: '2026-04-05' },
  { id: 'INV-0004', customerId: 'C004', customerName: 'Zulfiya Mirzayeva', items: [{ productId: 'P019', productName: 'Bej Ayollar Paltosi', quantity: 1, price: 780000, total: 780000 }], subtotal: 780000, discount: 78000, total: 702000, status: 'paid', createdAt: '2026-03-25', dueDate: '2026-04-10' },
  { id: 'INV-0005', customerId: 'C005', customerName: 'Sardor Rahimov', items: [{ productId: 'P003', productName: "Qora Biznes Ko'ylak", quantity: 3, price: 200000, total: 600000 }, { productId: 'P009', productName: 'Kulrang Biznes Shim', quantity: 2, price: 350000, total: 700000 }], subtotal: 1300000, discount: 130000, total: 1170000, status: 'paid', createdAt: '2026-04-01', dueDate: '2026-04-15' },
  { id: 'INV-0006', customerId: 'C006', customerName: 'Feruza Yusupova', items: [{ productId: 'P025', productName: 'Qora Kechki Libos', quantity: 1, price: 400000, total: 400000 }], subtotal: 400000, discount: 40000, total: 360000, status: 'paid', createdAt: '2026-04-05', dueDate: '2026-04-20' },
  { id: 'INV-0007', customerId: 'C007', customerName: 'Ulugbek Abdullayev', items: [{ productId: 'P018', productName: 'Kulrang Erkaklar Paltosi', quantity: 1, price: 850000, total: 850000 }], subtotal: 850000, discount: 85000, total: 765000, status: 'paid', createdAt: '2026-04-10', dueDate: '2026-04-25' },
  { id: 'INV-0008', customerId: 'C008', customerName: 'Shahlo Ergasheva', items: [{ productId: 'P022', productName: 'Qora Midi Yubka', quantity: 2, price: 140000, total: 280000 }, { productId: 'P028', productName: 'Charm Kamar', quantity: 1, price: 65000, total: 65000 }], subtotal: 345000, discount: 0, total: 345000, status: 'paid', createdAt: '2026-04-15', dueDate: '2026-04-30' },
  { id: 'INV-0009', customerId: 'C009', customerName: 'Shohruh Nazarov', items: [{ productId: 'P007', productName: "Ko'k Jins Shim", quantity: 2, price: 320000, total: 640000 }], subtotal: 640000, discount: 64000, total: 576000, status: 'paid', createdAt: '2026-04-20', dueDate: '2026-05-05' },
  { id: 'INV-0010', customerId: 'C010', customerName: 'Malika Qodirova', items: [{ productId: 'P015', productName: "Ko'k Denim Kurtka", quantity: 1, price: 380000, total: 380000 }, { productId: 'P024', productName: 'Sariq Chiziqli Yubka', quantity: 2, price: 110000, total: 220000 }], subtotal: 600000, discount: 60000, total: 540000, status: 'paid', createdAt: '2026-04-25', dueDate: '2026-05-10' },
  { id: 'INV-0011', customerId: 'C011', customerName: 'Doniyor Sobirov', items: [{ productId: 'P005', productName: "Kulrang Casual Ko'ylak", quantity: 2, price: 95000, total: 190000 }], subtotal: 190000, discount: 0, total: 190000, status: 'paid', createdAt: '2026-05-01', dueDate: '2026-05-15' },
  { id: 'INV-0012', customerId: 'C012', customerName: 'Dilnoza Hamidova', items: [{ productId: 'P026', productName: "Oq To'y Libosi", quantity: 1, price: 650000, total: 650000 }], subtotal: 650000, discount: 65000, total: 585000, status: 'paid', createdAt: '2026-05-05', dueDate: '2026-05-20' },
  { id: 'INV-0013', customerId: 'C013', customerName: 'Sanjar Ismoilov', items: [{ productId: 'P016', productName: 'Yashil Harbiy Kurtka', quantity: 1, price: 450000, total: 450000 }], subtotal: 450000, discount: 0, total: 450000, status: 'pending', createdAt: '2026-05-15', dueDate: '2026-05-30' },
  { id: 'INV-0014', customerId: 'C014', customerName: 'Nafisa Olimova', items: [{ productId: 'P002', productName: "Oq Yozgi Ko'ylak", quantity: 3, price: 85000, total: 255000 }], subtotal: 255000, discount: 0, total: 255000, status: 'pending', createdAt: '2026-05-20', dueDate: '2026-06-04' },
  { id: 'INV-0015', customerId: 'C015', customerName: 'Jahongir Ibrohimov', items: [{ productId: 'P017', productName: 'Qizil Puf Kurtka', quantity: 1, price: 520000, total: 520000 }, { productId: 'P008', productName: 'Bej Sport Shim', quantity: 1, price: 195000, total: 195000 }], subtotal: 715000, discount: 71500, total: 643500, status: 'pending', createdAt: '2026-05-25', dueDate: '2026-06-09' },
  { id: 'INV-0016', customerId: 'C016', customerName: 'Nargiza Normatova', items: [{ productId: 'P010', productName: "Yashil Sport Ko'nglak", quantity: 2, price: 180000, total: 360000 }], subtotal: 360000, discount: 0, total: 360000, status: 'pending', createdAt: '2026-05-28', dueDate: '2026-06-12' },
  { id: 'INV-0017', customerId: 'C017', customerName: 'Timur Tursunov', items: [{ productId: 'P029', productName: 'Ipak Galstuk', quantity: 3, price: 45000, total: 135000 }], subtotal: 135000, discount: 0, total: 135000, status: 'pending', createdAt: '2026-06-01', dueDate: '2026-06-15' },
  { id: 'INV-0018', customerId: 'C018', customerName: 'Muazzam Qosimova', items: [{ productId: 'P012', productName: "Oq Klassik Ko'nglak", quantity: 2, price: 160000, total: 320000 }], subtotal: 320000, discount: 32000, total: 288000, status: 'overdue', createdAt: '2026-04-01', dueDate: '2026-04-16' },
  { id: 'INV-0019', customerId: 'C019', customerName: 'Behruz Mamadaliyev', items: [{ productId: 'P020', productName: 'Qora Klasik Palto', quantity: 1, price: 920000, total: 920000 }], subtotal: 920000, discount: 92000, total: 828000, status: 'overdue', createdAt: '2026-03-15', dueDate: '2026-03-30' },
  { id: 'INV-0020', customerId: 'C020', customerName: 'Mohira Xolmatova', items: [{ productId: 'P011', productName: "Qora Slim Ko'nglak", quantity: 1, price: 220000, total: 220000 }, { productId: 'P013', productName: "Ko'k Stripe Ko'nglak", quantity: 1, price: 195000, total: 195000 }], subtotal: 415000, discount: 0, total: 415000, status: 'overdue', createdAt: '2026-03-20', dueDate: '2026-04-04' },
]

// ─── Requests (15) ─────────────────────────────────────────────────────────

export const mockRequests: Request[] = [
  { id: 'REQ-001', customerId: 'C001', customerName: 'Jasur Toshmatov', type: 'complaint', priority: 'high', status: 'new', message: "Ko'ylak hajmi noto'g'ri keldi, almashtirish kerak.", createdAt: '2026-06-04', notes: '' },
  { id: 'REQ-002', customerId: 'C003', customerName: 'Bobur Xasanov', type: 'return', priority: 'high', status: 'in-progress', message: 'Kurtka rangi bir haftadan so\'ng o\'zgarib qoldi. Qaytarish so\'raladi.', createdAt: '2026-06-02', notes: 'Mijoz bilan bog\'lanildi, qaytarish tasdiqlandi.' },
  { id: 'REQ-003', customerId: 'C005', customerName: 'Sardor Rahimov', type: 'inquiry', priority: 'medium', status: 'resolved', message: 'Yangi to\'plam qachon kelishini so\'ramoqda.', createdAt: '2026-05-28', notes: "Iyul oyida yangi to'plam kelishi haqida xabar berildi." },
  { id: 'REQ-004', customerId: 'C012', customerName: 'Dilnoza Hamidova', type: 'complaint', priority: 'medium', status: 'in-progress', message: 'Libosning tikmasi sifatsiz, bir kunda yirtildi.', createdAt: '2026-06-03', notes: 'Sifat nazorat bo\'limiga yuborildi.' },
  { id: 'REQ-005', customerId: 'C015', customerName: 'Jahongir Ibrohimov', type: 'inquiry', priority: 'low', status: 'new', message: 'VIP chegirma shartnomasi haqida ma\'lumot olmoqchi.', createdAt: '2026-06-05', notes: '' },
  { id: 'REQ-006', customerId: 'C007', customerName: 'Ulugbek Abdullayev', type: 'return', priority: 'high', status: 'resolved', message: "Palto o'lchamlari farq qildi. To'liq qaytarish talab qilinadi.", createdAt: '2026-05-20', notes: 'Pul qaytarildi.' },
  { id: 'REQ-007', customerId: 'C002', customerName: 'Nilufar Karimova', type: 'inquiry', priority: 'low', status: 'resolved', message: 'Qaysi materiallar gipoallergen ekanligini bilmoqchi.', createdAt: '2026-05-25', notes: 'To\'liq ma\'lumot elektron pochta orqali yuborildi.' },
  { id: 'REQ-008', customerId: 'C019', customerName: 'Behruz Mamadaliyev', type: 'complaint', priority: 'high', status: 'new', message: 'Hisob-kitob summasi xato hisoblangan.', createdAt: '2026-06-05', notes: '' },
  { id: 'REQ-009', customerId: 'C025', customerName: 'Rustam Xudoyberdiyev', type: 'inquiry', priority: 'medium', status: 'in-progress', message: 'Maxsus buyurtma uchun qaysi to\'qimalardan foydalaniladi?', createdAt: '2026-06-01', notes: 'Ishlab chiqaruvchi bilan muloqot davom etmoqda.' },
  { id: 'REQ-010', customerId: 'C008', customerName: 'Shahlo Ergasheva', type: 'return', priority: 'medium', status: 'resolved', message: 'Yubka rangiga qanoatlanmadim, boshqa rang kerak.', createdAt: '2026-05-18', notes: 'Almashtirish amalga oshirildi.' },
  { id: 'REQ-011', customerId: 'C033', customerName: 'Lochin Nazarov', type: 'complaint', priority: 'low', status: 'new', message: 'Yetkazib berish kechikdi, 3 kun kech keldi.', createdAt: '2026-06-04', notes: '' },
  { id: 'REQ-012', customerId: 'C010', customerName: 'Malika Qodirova', type: 'inquiry', priority: 'low', status: 'resolved', message: 'Karta orqali to\'lash imkoniyati bormi?', createdAt: '2026-05-22', notes: 'Barcha to\'lov usullari haqida ma\'lumot berildi.' },
  { id: 'REQ-013', customerId: 'C041', customerName: 'Alisher Tursunov', type: 'inquiry', priority: 'low', status: 'in-progress', message: 'Birinchi xarid uchun chegirma bormi?', createdAt: '2026-06-02', notes: "Yangi mijozlar uchun 10% chegirma haqida xabar berildi." },
  { id: 'REQ-014', customerId: 'C006', customerName: 'Feruza Yusupova', type: 'return', priority: 'medium', status: 'new', message: 'Libos tavsifda ko\'rsatilgandan boshqacha chiqdi.', createdAt: '2026-06-06', notes: '' },
  { id: 'REQ-015', customerId: 'C029', customerName: 'Mirzo Rahimov', type: 'complaint', priority: 'medium', status: 'in-progress', message: 'Hisob-faktura yuborilmagan, iltimos qayta yuboring.', createdAt: '2026-06-03', notes: 'Hisob-faktura qayta yuborildi.' },
]

// ─── Campaigns & Coupons ────────────────────────────────────────────────────

export const mockCampaigns: Campaign[] = [
  { id: 'CAM-001', name: 'Ramazon Chegirmasi', type: 'discount', status: 'ended', discount: 25, startDate: '2026-03-01', endDate: '2026-03-31', usageCount: 87, usageLimit: 100 },
  { id: 'CAM-002', name: 'Yozgi Aksiya', type: 'promo', status: 'active', discount: 15, startDate: '2026-06-01', endDate: '2026-08-31', usageCount: 34, usageLimit: 200 },
  { id: 'CAM-003', name: 'VIP Maxsus Taklif', type: 'coupon', status: 'active', discount: 30, startDate: '2026-05-01', endDate: '2026-07-31', usageCount: 18, usageLimit: 50 },
  { id: 'CAM-004', name: 'Yangi Mijozlar Bonusi', type: 'discount', status: 'active', discount: 10, startDate: '2026-04-01', endDate: '2026-12-31', usageCount: 25, usageLimit: 500 },
  { id: 'CAM-005', name: 'Qish Kolleksiyasi Taqdimoti', type: 'promo', status: 'inactive', discount: 20, startDate: '2026-11-01', endDate: '2026-11-30', usageCount: 0, usageLimit: 150 },
]

export const mockCoupons: Coupon[] = [
  { id: 'CPN-001', code: 'RAMAZON25', discount: 25, usageLimit: 100, usedCount: 87, expiryDate: '2026-03-31', status: 'expired' },
  { id: 'CPN-002', code: 'YOZI2026', discount: 15, usageLimit: 200, usedCount: 34, expiryDate: '2026-08-31', status: 'active' },
  { id: 'CPN-003', code: 'VIP30', discount: 30, usageLimit: 50, usedCount: 18, expiryDate: '2026-07-31', status: 'active' },
  { id: 'CPN-004', code: 'YANGI10', discount: 10, usageLimit: 500, usedCount: 25, expiryDate: '2026-12-31', status: 'active' },
  { id: 'CPN-005', code: 'QISH20', discount: 20, usageLimit: 150, usedCount: 0, expiryDate: '2026-11-30', status: 'inactive' },
]

// ─── Stock In / Out entries ────────────────────────────────────────────────

const SUPPLIERS = [
  "ABC Tekstil MChJ", 'Tashkent Tex Import', "Osiyo Kiyim Ta'minot",
  'Brilliant Tekstil', 'Najot Tekstil Group', 'Yangi Avlod Trade',
  'Premium Garment Co', 'Silk Road Tekstil',
]

const KIRIM_NOTES = ['', '', "Yangi mavsum kolleksiyasi", "Sifat nazoratidan o'tgan", 'Shoshilinch buyurtma']
const CHIQIM_NOTES = ['', '', 'Doimiy mijoz', 'Aksiya doirasida sotildi', 'Kassa orqali']

function dateTimeAt(base: string, daysOffset: number, hour: number, minute: number): string {
  const d = new Date(base)
  d.setDate(d.getDate() + daysOffset)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hh = String(hour).padStart(2, '0')
  const mm = String(minute).padStart(2, '0')
  return `${y}-${m}-${day}T${hh}:${mm}:00`
}

function generateStockInEntries(): StockInEntry[] {
  const entries: StockInEntry[] = []
  const productIndices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29]
  const COUNT = 90

  for (let i = 0; i < COUNT; i++) {
    const dayOffset = Math.floor((i / COUNT) * 44)
    const product = mockProducts[productIndices[i % productIndices.length]]
    const size = 'M'
    const color = product.colors[i % product.colors.length]
    const quantity = 10 + (i % 8) * 5
    const unitPrice = Math.round((product.price * 0.6) / 1000) * 1000

    entries.push({
      id: `KIR-${String(i + 1).padStart(3, '0')}`,
      productId: product.id,
      productName: product.name,
      category: product.category,
      size,
      color,
      quantity,
      unitPrice,
      totalAmount: quantity * unitPrice,
      purchasePrice: unitPrice,
      sellingPrice: Math.round((product.price) / 1000) * 1000,
      supplier: SUPPLIERS[i % SUPPLIERS.length],
      date: dateTimeAt('2026-04-23', dayOffset, 9 + (i % 9), (i * 17) % 60),
      note: KIRIM_NOTES[i % KIRIM_NOTES.length],
    })
  }
  return entries
}

function generateStockOutEntries(): StockOutEntry[] {
  const entries: StockOutEntry[] = []
  const productIndices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29]
  const COUNT = 110

  for (let i = 0; i < COUNT; i++) {
    const dayOffset = Math.floor((i / COUNT) * 44)
    const product = mockProducts[productIndices[i % productIndices.length]]
    const size = 'M'
    const color = product.colors[i % product.colors.length]
    const quantity = 1 + (i % 5)
    const sellPrice = product.price
    const customer = mockCustomers[i % mockCustomers.length]

    entries.push({
      id: `CHQ-${String(i + 1).padStart(3, '0')}`,
      productId: product.id,
      productName: product.name,
      category: product.category,
      size,
      color,
      quantity,
      sellPrice,
      totalAmount: quantity * sellPrice,
      customerId: customer.id,
      customerName: customer.fullName,
      paymentMethod: PAYMENT_METHODS[i % PAYMENT_METHODS.length],
      date: dateTimeAt('2026-04-23', dayOffset, 10 + (i % 8), (i * 13) % 60),
      note: CHIQIM_NOTES[i % CHIQIM_NOTES.length],
    })
  }
  return entries
}

export const mockStockInEntries: StockInEntry[] = generateStockInEntries()
export const mockStockOutEntries: StockOutEntry[] = generateStockOutEntries()

// ─── Product Groups (7) ────────────────────────────────────────────────────

export const mockProductGroups: ProductGroup[] = [
  { id: 'pg1', name: "Ko'ylak", description: "Erkaklar va ayollar ko'ylaklari", productsCount: 8, status: 'active', sizeType: 'clothing' },
  { id: 'pg2', name: 'Shim', description: 'Har xil shim turlari', productsCount: 6, status: 'active', sizeType: 'clothing' },
  { id: 'pg3', name: 'Kurtka', description: 'Kurtka va jaketlar', productsCount: 5, status: 'active', sizeType: 'clothing' },
  { id: 'pg4', name: 'Libos', description: 'Ayollar libosilari', productsCount: 7, status: 'active', sizeType: 'clothing' },
  { id: 'pg5', name: 'Palto', description: 'Qishki va bahorgi paltolar', productsCount: 4, status: 'active', sizeType: 'clothing' },
  { id: 'pg6', name: 'Yubka', description: 'Ayollar yubkalari', productsCount: 3, status: 'active', sizeType: 'clothing' },
  { id: 'pg7', name: 'Aksessuar', description: 'Kiyim aksessuarlari', productsCount: 5, status: 'active', sizeType: 'clothing' },
]

// ─── HR: Departments (5) ────────────────────────────────────────────────────

export const mockDepartments: Department[] = [
  { id: 'dep1', name: "Savdo bo'limi", managerId: 'e1', managerName: 'Aziz Karimov', description: "Do'kon savdosi va kassa nazorati", employeesCount: 5, status: 'active' },
  { id: 'dep2', name: 'Ombor bo\'limi', managerId: 'e4', managerName: 'Madina Tosheva', description: "Mahsulotlar zaxirasi va omborni boshqarish", employeesCount: 2, status: 'active' },
  { id: 'dep3', name: 'Moliya bo\'limi', managerId: 'e5', managerName: 'Jasur Rahimov', description: "Buxgalteriya va moliyaviy hisobotlar", employeesCount: 1, status: 'active' },
  { id: 'dep4', name: 'Marketing bo\'limi', managerId: 'e6', managerName: 'Nilufar Karimova', description: "Reklama va mijozlar bilan ishlash", employeesCount: 1, status: 'active' },
  { id: 'dep5', name: "Xizmat ko'rsatish", managerId: 'e10', managerName: 'Gulnora Ismoilova', description: "Mijozlarga xizmat ko'rsatish bo'limi", employeesCount: 1, status: 'active' },
]

// ─── HR: Positions (6) ──────────────────────────────────────────────────────

export const mockPositions: Position[] = [
  { id: 'pos1', name: 'Kassir', departmentId: 'dep1', departmentName: "Savdo bo'limi", employeesCount: 2, description: "Kassada to'lovlarni qabul qilish", status: 'active' },
  { id: 'pos2', name: 'Sotuvchi', departmentId: 'dep1', departmentName: "Savdo bo'limi", employeesCount: 3, description: "Mijozlarga mahsulot taqdim etish va sotish", status: 'active' },
  { id: 'pos3', name: 'Omborchi', departmentId: 'dep2', departmentName: "Ombor bo'limi", employeesCount: 2, description: "Ombordagi mahsulotlar hisobi va joylashtirish", status: 'active' },
  { id: 'pos4', name: 'Menejer', departmentId: 'dep1', departmentName: "Savdo bo'limi", employeesCount: 1, description: "Savdo bo'limi faoliyatini boshqarish", status: 'active' },
  { id: 'pos5', name: 'Buxgalter', departmentId: 'dep3', departmentName: "Moliya bo'limi", employeesCount: 1, description: "Moliyaviy hisob-kitoblarni yuritish", status: 'active' },
  { id: 'pos6', name: 'Marketing mutaxassisi', departmentId: 'dep4', departmentName: "Marketing bo'limi", employeesCount: 1, description: "Reklama kampaniyalarini rejalashtirish", status: 'active' },
]

// ─── HR: Employees (10) ─────────────────────────────────────────────────────

export const mockEmployees: Employee[] = [
  {
    id: 'e1', firstName: 'Aziz', lastName: 'Karimov', phone: '+998901112233', birthDate: '1990-04-12',
    address: 'Toshkent, Yunusobod tumani', positionId: 'pos4', positionName: 'Menejer',
    departmentId: 'dep1', departmentName: "Savdo bo'limi", salary: 6500000, startDate: '2024-01-10',
    photoUrl: '', status: 'active',
    history: [
      { id: 'h1', date: '2024-01-10', positionName: 'Sotuvchi', departmentName: "Savdo bo'limi", salary: 3000000, note: 'Ishga qabul qilindi' },
      { id: 'h2', date: '2025-03-01', positionName: 'Menejer', departmentName: "Savdo bo'limi", salary: 6000000, note: "Menejer lavozimiga ko'tarildi" },
    ],
  },
  {
    id: 'e2', firstName: 'Dilnoza', lastName: 'Yusupova', phone: '+998912223344', birthDate: '1995-07-22',
    address: 'Toshkent, Chilonzor tumani', positionId: 'pos2', positionName: 'Sotuvchi',
    departmentId: 'dep1', departmentName: "Savdo bo'limi", salary: 3200000, startDate: '2024-05-15',
    photoUrl: '', status: 'active',
    history: [
      { id: 'h3', date: '2024-05-15', positionName: 'Sotuvchi', departmentName: "Savdo bo'limi", salary: 3000000, note: 'Ishga qabul qilindi' },
    ],
  },
  {
    id: 'e3', firstName: 'Sardor', lastName: 'Aliyev', phone: '+998933334455', birthDate: '1992-11-03',
    address: 'Toshkent, Mirzo Ulug\'bek tumani', positionId: 'pos1', positionName: 'Kassir',
    departmentId: 'dep1', departmentName: "Savdo bo'limi", salary: 3800000, startDate: '2023-09-01',
    photoUrl: '', status: 'active',
    history: [
      { id: 'h4', date: '2023-09-01', positionName: 'Kassir', departmentName: "Savdo bo'limi", salary: 3500000, note: 'Ishga qabul qilindi' },
    ],
  },
  {
    id: 'e4', firstName: 'Madina', lastName: 'Tosheva', phone: '+998944445566', birthDate: '1989-02-18',
    address: 'Toshkent, Sergeli tumani', positionId: 'pos3', positionName: 'Omborchi',
    departmentId: 'dep2', departmentName: "Ombor bo'limi", salary: 3500000, startDate: '2023-04-20',
    photoUrl: '', status: 'active',
    history: [
      { id: 'h5', date: '2023-04-20', positionName: 'Omborchi', departmentName: "Ombor bo'limi", salary: 3200000, note: 'Ishga qabul qilindi' },
    ],
  },
  {
    id: 'e5', firstName: 'Jasur', lastName: 'Rahimov', phone: '+998955556677', birthDate: '1987-06-09',
    address: 'Toshkent, Shayxontohur tumani', positionId: 'pos5', positionName: 'Buxgalter',
    departmentId: 'dep3', departmentName: "Moliya bo'limi", salary: 5800000, startDate: '2022-11-12',
    photoUrl: '', status: 'active',
    history: [
      { id: 'h6', date: '2022-11-12', positionName: 'Buxgalter', departmentName: "Moliya bo'limi", salary: 5500000, note: 'Ishga qabul qilindi' },
    ],
  },
  {
    id: 'e6', firstName: 'Nilufar', lastName: 'Karimova', phone: '+998966667788', birthDate: '1994-09-27',
    address: 'Toshkent, Olmazor tumani', positionId: 'pos6', positionName: 'Marketing mutaxassisi',
    departmentId: 'dep4', departmentName: "Marketing bo'limi", salary: 4700000, startDate: '2024-02-05',
    photoUrl: '', status: 'on-leave',
    history: [
      { id: 'h7', date: '2024-02-05', positionName: 'Marketing mutaxassisi', departmentName: "Marketing bo'limi", salary: 4500000, note: 'Ishga qabul qilindi' },
    ],
  },
  {
    id: 'e7', firstName: 'Bekzod', lastName: 'Yoldashev', phone: '+998977778899', birthDate: '1996-12-30',
    address: 'Toshkent, Yashnobod tumani', positionId: 'pos2', positionName: 'Sotuvchi',
    departmentId: 'dep1', departmentName: "Savdo bo'limi", salary: 3100000, startDate: '2025-01-20',
    photoUrl: '', status: 'active',
    history: [
      { id: 'h8', date: '2025-01-20', positionName: 'Sotuvchi', departmentName: "Savdo bo'limi", salary: 3000000, note: 'Ishga qabul qilindi' },
    ],
  },
  {
    id: 'e8', firstName: 'Shahnoza', lastName: 'Ergasheva', phone: '+998988889900', birthDate: '1993-03-14',
    address: 'Toshkent, Bektemir tumani', positionId: 'pos1', positionName: 'Kassir',
    departmentId: 'dep1', departmentName: "Savdo bo'limi", salary: 3600000, startDate: '2023-06-10',
    photoUrl: '', status: 'terminated',
    history: [
      { id: 'h9', date: '2023-06-10', positionName: 'Kassir', departmentName: "Savdo bo'limi", salary: 3500000, note: 'Ishga qabul qilindi' },
      { id: 'h10', date: '2026-05-10', positionName: 'Kassir', departmentName: "Savdo bo'limi", salary: 3500000, note: 'Shartnoma tugatildi' },
    ],
  },
  {
    id: 'e9', firstName: 'Otabek', lastName: 'Nazarov', phone: '+998999990011', birthDate: '1991-08-05',
    address: 'Toshkent, Uchtepa tumani', positionId: 'pos3', positionName: 'Omborchi',
    departmentId: 'dep2', departmentName: "Ombor bo'limi", salary: 3400000, startDate: '2024-08-01',
    photoUrl: '', status: 'active',
    history: [
      { id: 'h11', date: '2024-08-01', positionName: 'Omborchi', departmentName: "Ombor bo'limi", salary: 3200000, note: 'Ishga qabul qilindi' },
    ],
  },
  {
    id: 'e10', firstName: 'Gulnora', lastName: 'Ismoilova', phone: '+998901230099', birthDate: '1997-01-25',
    address: 'Toshkent, Yakkasaroy tumani', positionId: 'pos2', positionName: 'Sotuvchi',
    departmentId: 'dep5', departmentName: "Xizmat ko'rsatish", salary: 2800000, startDate: '2025-06-01',
    photoUrl: '', status: 'active',
    history: [
      { id: 'h12', date: '2025-06-01', positionName: 'Sotuvchi', departmentName: "Xizmat ko'rsatish", salary: 3000000, note: 'Ishga qabul qilindi' },
    ],
  },
]

// ─── HR: Reward / Penalty type definitions ─────────────────────────────────

export const mockRewardTypes: RewardPenaltyTypeDef[] = [
  { id: 'rt1', name: 'Oylik mukofot', amount: 500000, kind: 'fixed', description: "Har oy ajratiladigan doimiy mukofot" },
  { id: 'rt2', name: 'Reja bajarish', amount: 10, kind: 'percent', description: "Sotuv rejasi bajarilganda maoshdan foiz" },
  { id: 'rt3', name: 'Eng yaxshi xodim', amount: 300000, kind: 'oneTime', description: "Oyning eng yaxshi xodimiga bir martalik mukofot" },
  { id: 'rt4', name: 'Bayram mukofoti', amount: 200000, kind: 'oneTime', description: "Bayram munosabati bilan bir martalik mukofot" },
]

export const mockPenaltyTypes: RewardPenaltyTypeDef[] = [
  { id: 'pt1', name: 'Kechikish', amount: 50000, kind: 'perOccurrence', description: "Ishga kechikkanda har safar ushlanadigan jarima" },
  { id: 'pt2', name: 'Reja bajarmaslik', amount: 5, kind: 'percent', description: "Sotuv rejasi bajarilmaganda maoshdan foiz" },
  { id: 'pt3', name: 'Tartib buzish', amount: 100000, kind: 'oneTime', description: "Ichki tartib qoidalarini buzganda bir martalik jarima" },
  { id: 'pt4', name: "Yo'qlik", amount: 150000, kind: 'perDay', description: "Sababsiz ishga kelmagan har bir kun uchun jarima" },
]

// ─── HR: Reward / Penalty entries (10) ─────────────────────────────────────

export const mockRewardPenalties: RewardPenaltyEntry[] = [
  { id: 'rp1', employeeId: 'e2', employeeName: 'Dilnoza Yusupova', departmentName: "Savdo bo'limi", type: 'reward', typeId: 'rt1', typeName: 'Oylik mukofot', amount: 500000, date: '2026-06-01', note: 'Iyun oyi mukofoti' },
  { id: 'rp2', employeeId: 'e3', employeeName: 'Sardor Aliyev', departmentName: "Savdo bo'limi", type: 'reward', typeId: 'rt3', typeName: 'Eng yaxshi xodim', amount: 300000, date: '2026-05-28', note: 'May oyining eng yaxshi xodimi' },
  { id: 'rp3', employeeId: 'e7', employeeName: 'Bekzod Yoldashev', departmentName: "Savdo bo'limi", type: 'penalty', typeId: 'pt1', typeName: 'Kechikish', amount: 50000, date: '2026-06-03', note: '10 daqiqaga kechikdi' },
  { id: 'rp4', employeeId: 'e9', employeeName: 'Otabek Nazarov', departmentName: "Ombor bo'limi", type: 'reward', typeId: 'rt2', typeName: 'Reja bajarish', amount: 320000, date: '2026-05-30', note: 'Reja 110% bajarildi' },
  { id: 'rp5', employeeId: 'e8', employeeName: 'Shahnoza Ergasheva', departmentName: "Savdo bo'limi", type: 'penalty', typeId: 'pt3', typeName: 'Tartib buzish', amount: 100000, date: '2026-05-15', note: 'Ish tartibini buzgani uchun' },
  { id: 'rp6', employeeId: 'e6', employeeName: 'Nilufar Karimova', departmentName: "Marketing bo'limi", type: 'penalty', typeId: 'pt4', typeName: "Yo'qlik", amount: 150000, date: '2026-05-20', note: '1 kun ishga kelmadi' },
  { id: 'rp7', employeeId: 'e1', employeeName: 'Aziz Karimov', departmentName: "Savdo bo'limi", type: 'reward', typeId: 'rt4', typeName: 'Bayram mukofoti', amount: 200000, date: '2026-06-05', note: 'Bayram munosabati bilan' },
  { id: 'rp8', employeeId: 'e10', employeeName: 'Gulnora Ismoilova', departmentName: "Xizmat ko'rsatish", type: 'reward', typeId: 'rt1', typeName: 'Oylik mukofot', amount: 500000, date: '2026-06-01', note: 'Iyun oyi mukofoti' },
  { id: 'rp9', employeeId: 'e3', employeeName: 'Sardor Aliyev', departmentName: "Savdo bo'limi", type: 'penalty', typeId: 'pt1', typeName: 'Kechikish', amount: 50000, date: '2026-06-02', note: '15 daqiqaga kechikdi' },
  { id: 'rp10', employeeId: 'e2', employeeName: 'Dilnoza Yusupova', departmentName: "Savdo bo'limi", type: 'penalty', typeId: 'pt2', typeName: 'Reja bajarmaslik', amount: 150000, date: '2026-05-25', note: 'Reja bajarilmadi' },
]
