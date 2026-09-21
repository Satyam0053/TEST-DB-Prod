/**
 * ClientApi.gs
 * Not one of the originally-numbered phases - required because of how
 * Google Apps Script's client/server bridge actually works: google.script.run
 * can only invoke a top-level global function declared with `function name(...)`
 * in a .gs file. It CANNOT reach into a namespaced object like
 * `var FMSService = { startStage: ... }` and call `FMSService.startStage`
 * as a nested property - google.script.run's client-side proxy is built by
 * reflecting the project's top-level global function declarations only.
 *
 * Every *Service.gs file in this project uses the IIFE module pattern
 * (`var XService = (function () { ... return {...}; })();`) so that the
 * Apps Script editor's function picker and any file can call e.g.
 * `JobCardService.createJobCard(...)` directly and unambiguously - that
 * pattern is kept as-is. This file is the thin, flat, globally-unique layer
 * of top-level functions that google.script.run actually calls; each one
 * does nothing but forward straight to the real implementation. JS.html's
 * callServer() calls these by their bare method name (e.g. 'startStage',
 * not 'FMSService.startStage') for exactly this reason.
 *
 * Every method name below was verified unique across all *Service.gs files
 * before this file was generated (no two services export the same public
 * method name) - see the project's delivery notes. AuthService.validateSession/
 * hasPermission/hashPassword/verifyPassword are deliberately NOT wrapped here:
 * they are internal, server-to-server only, and must never be reachable
 * directly from the client.
 *
 * ES5 only.
 */

// ---- ArtworkService ----------------------------------------------
function issueArtwork() {
  return ArtworkService.issueArtwork.apply(null, arguments);
}
function receiveArtwork() {
  return ArtworkService.receiveArtwork.apply(null, arguments);
}
function closeArtwork() {
  return ArtworkService.closeArtwork.apply(null, arguments);
}
function getArtwork() {
  return ArtworkService.getArtwork.apply(null, arguments);
}
function listArtwork() {
  return ArtworkService.listArtwork.apply(null, arguments);
}

// ---- AuthService -------------------------------------------------
function login() {
  return AuthService.login.apply(null, arguments);
}
function logout() {
  return AuthService.logout.apply(null, arguments);
}

// ---- DashboardService --------------------------------------------
function getOverviewKpis() {
  return DashboardService.getOverviewKpis.apply(null, arguments);
}
function getJobCardSummary() {
  return DashboardService.getJobCardSummary.apply(null, arguments);
}
function getFmsStageSummary() {
  return DashboardService.getFmsStageSummary.apply(null, arguments);
}
function getProductionSummary() {
  return DashboardService.getProductionSummary.apply(null, arguments);
}
function getInventorySummary() {
  return DashboardService.getInventorySummary.apply(null, arguments);
}
function getArtworkSummary() {
  return DashboardService.getArtworkSummary.apply(null, arguments);
}
function getQualitySummary() {
  return DashboardService.getQualitySummary.apply(null, arguments);
}
function getDeliverySummary() {
  return DashboardService.getDeliverySummary.apply(null, arguments);
}
function getTatBreaches() {
  return DashboardService.getTatBreaches.apply(null, arguments);
}

// ---- DeliveryService ---------------------------------------------
function createDeliveryRecord() {
  return DeliveryService.createDeliveryRecord.apply(null, arguments);
}
function recordPacking() {
  return DeliveryService.recordPacking.apply(null, arguments);
}
function recordReady() {
  return DeliveryService.recordReady.apply(null, arguments);
}
function recordDispatch() {
  return DeliveryService.recordDispatch.apply(null, arguments);
}
function refreshDeliveryStatus() {
  return DeliveryService.refreshDeliveryStatus.apply(null, arguments);
}
function getDelivery() {
  return DeliveryService.getDelivery.apply(null, arguments);
}
function listDeliveries() {
  return DeliveryService.listDeliveries.apply(null, arguments);
}
function getOtdSummary() {
  return DeliveryService.getOtdSummary.apply(null, arguments);
}

// ---- FMSService --------------------------------------------------
function startStage() {
  return FMSService.startStage.apply(null, arguments);
}
function updateStageProgress() {
  return FMSService.updateStageProgress.apply(null, arguments);
}
function holdStage() {
  return FMSService.holdStage.apply(null, arguments);
}
function resumeStage() {
  return FMSService.resumeStage.apply(null, arguments);
}
function listStageQueue() {
  return FMSService.listStageQueue.apply(null, arguments);
}

// ---- InventoryService --------------------------------------------
function recordFabricTransaction() {
  return InventoryService.recordFabricTransaction.apply(null, arguments);
}
function getFabricStock() {
  return InventoryService.getFabricStock.apply(null, arguments);
}
function listFabricStock() {
  return InventoryService.listFabricStock.apply(null, arguments);
}
function listFabricTransactions() {
  return InventoryService.listFabricTransactions.apply(null, arguments);
}
function issueFabricToFabricator() {
  return InventoryService.issueFabricToFabricator.apply(null, arguments);
}
function returnFabricFromFabricator() {
  return InventoryService.returnFabricFromFabricator.apply(null, arguments);
}
function listFabricatorIssues() {
  return InventoryService.listFabricatorIssues.apply(null, arguments);
}
function recordInventoryTransaction() {
  return InventoryService.recordInventoryTransaction.apply(null, arguments);
}
function getInventoryStock() {
  return InventoryService.getInventoryStock.apply(null, arguments);
}
function listInventoryStock() {
  return InventoryService.listInventoryStock.apply(null, arguments);
}
function listInventoryTransactions() {
  return InventoryService.listInventoryTransactions.apply(null, arguments);
}

// ---- JobCardService ----------------------------------------------
function createJobCard() {
  return JobCardService.createJobCard.apply(null, arguments);
}
function getJobCard() {
  return JobCardService.getJobCard.apply(null, arguments);
}
function getJobCardByNo() {
  return JobCardService.getJobCardByNo.apply(null, arguments);
}
function listJobCards() {
  return JobCardService.listJobCards.apply(null, arguments);
}
function updateJobCard() {
  return JobCardService.updateJobCard.apply(null, arguments);
}
function cancelJobCard() {
  return JobCardService.cancelJobCard.apply(null, arguments);
}

// ---- MasterDataService -------------------------------------------
function listBuyers() {
  return MasterDataService.listBuyers.apply(null, arguments);
}
function listVendors() {
  return MasterDataService.listVendors.apply(null, arguments);
}
function listStyles() {
  return MasterDataService.listStyles.apply(null, arguments);
}
function listArticles() {
  return MasterDataService.listArticles.apply(null, arguments);
}
function listEmployees() {
  return MasterDataService.listEmployees.apply(null, arguments);
}
function listProductionLines() {
  return MasterDataService.listProductionLines.apply(null, arguments);
}
function listFmsStages() {
  return MasterDataService.listFmsStages.apply(null, arguments);
}
function listFabricItems() {
  return MasterDataService.listFabricItems.apply(null, arguments);
}
function listInventoryItems() {
  return MasterDataService.listInventoryItems.apply(null, arguments);
}

// ---- ProductionService -------------------------------------------
function createBundle() {
  return ProductionService.createBundle.apply(null, arguments);
}
function startBundle() {
  return ProductionService.startBundle.apply(null, arguments);
}
function recordBundleProgress() {
  return ProductionService.recordBundleProgress.apply(null, arguments);
}
function holdBundle() {
  return ProductionService.holdBundle.apply(null, arguments);
}
function resumeBundle() {
  return ProductionService.resumeBundle.apply(null, arguments);
}
function cancelBundle() {
  return ProductionService.cancelBundle.apply(null, arguments);
}
function getBundle() {
  return ProductionService.getBundle.apply(null, arguments);
}
function listBundles() {
  return ProductionService.listBundles.apply(null, arguments);
}

// ---- PurchaseService ---------------------------------------------
function createPurchaseOrder() {
  return PurchaseService.createPurchaseOrder.apply(null, arguments);
}
function updatePurchaseOrder() {
  return PurchaseService.updatePurchaseOrder.apply(null, arguments);
}
function updatePurchaseOrderStatus() {
  return PurchaseService.updatePurchaseOrderStatus.apply(null, arguments);
}
function getPurchaseOrder() {
  return PurchaseService.getPurchaseOrder.apply(null, arguments);
}
function listPurchaseOrders() {
  return PurchaseService.listPurchaseOrders.apply(null, arguments);
}

// ---- QualityService ----------------------------------------------
function recordInspection() {
  return QualityService.recordInspection.apply(null, arguments);
}
function getInspection() {
  return QualityService.getInspection.apply(null, arguments);
}
function listInspections() {
  return QualityService.listInspections.apply(null, arguments);
}
function getDefectSummary() {
  return QualityService.getDefectSummary.apply(null, arguments);
}

// ---- UserService -------------------------------------------------
function createUser() {
  return UserService.createUser.apply(null, arguments);
}
function updateUser() {
  return UserService.updateUser.apply(null, arguments);
}
function setUserActive() {
  return UserService.setUserActive.apply(null, arguments);
}
function resetUserPassword() {
  return UserService.resetUserPassword.apply(null, arguments);
}
function getUser() {
  return UserService.getUser.apply(null, arguments);
}
function listUsers() {
  return UserService.listUsers.apply(null, arguments);
}
function createRole() {
  return UserService.createRole.apply(null, arguments);
}
function updateRole() {
  return UserService.updateRole.apply(null, arguments);
}
function listRoles() {
  return UserService.listRoles.apply(null, arguments);
}
function listPermissions() {
  return UserService.listPermissions.apply(null, arguments);
}
function getRolePermissions() {
  return UserService.getRolePermissions.apply(null, arguments);
}
function setRolePermissions() {
  return UserService.setRolePermissions.apply(null, arguments);
}
