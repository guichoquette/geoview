import BaseLayer from 'ol/layer/Base';
import { Coordinate } from 'ol/coordinate';
import { Pixel } from 'ol/pixel';
import { Extent } from 'ol/extent';
import Feature from 'ol/Feature';
import VectorTileLayer from 'ol/layer/VectorTile';
import BaseVectorLayer from 'ol/layer/BaseVector';
import ImageLayer from 'ol/layer/Image';
import Source from 'ol/source/Source';

import { TypeLocalizedString } from '@config/types/map-schema-types';

import { getLocalizedValue } from '@/core/utils/utilities';
import { TimeDimension, DateMgt, TypeDateFragments } from '@/core/utils/date-mgt';
import { logger } from '@/core/utils/logger';
import { AsyncSemaphore } from '@/core/utils/async-semaphore';
import { EsriDynamicLayerEntryConfig } from '@/core/utils/config/validation-classes/raster-validation-classes/esri-dynamic-layer-entry-config';
import { OgcWmsLayerEntryConfig } from '@/core/utils/config/validation-classes/raster-validation-classes/ogc-wms-layer-entry-config';
import { VectorLayerEntryConfig } from '@/core/utils/config/validation-classes/vector-layer-entry-config';
import { AbstractBaseLayerEntryConfig } from '@/core/utils/config/validation-classes/abstract-base-layer-entry-config';
import EventHelper, { EventDelegateBase } from '@/api/events/event-helper';
import { LegendEventProcessor } from '@/api/event-processors/event-processor-children/legend-event-processor';
import {
  TypeStyleConfig,
  TypeLayerStatusSimplified,
  TypeLayerStatus,
  TypeFeatureInfoEntry,
  codedValueType,
  rangeDomainType,
  TypeLocation,
  QueryType,
} from '@/geo/map/map-schema-types';
import { getLegendStyles, getFeatureCanvas } from '@/geo/utils/renderer/geoview-renderer';
import { TypeLegend } from '@/core/stores/store-interface-and-intial-values/layer-state';
import { MapEventProcessor } from '@/api/event-processors/event-processor-children/map-event-processor';
import { MapViewer } from '@/geo/map/map-viewer';

/**
 * Abstract Geoview Layer managing an OpenLayer layer.
 */
export abstract class AbstractGVLayer {
  // The default hit tolerance the query should be using
  static DEFAULT_HIT_TOLERANCE: number = 4;

  // The default hit tolerance
  hitTolerance: number = AbstractGVLayer.DEFAULT_HIT_TOLERANCE;

  // The map id
  #mapId: string;

  // The OpenLayer layer
  #olLayer: BaseLayer;

  // The layer configuration
  #layerConfig: AbstractBaseLayerEntryConfig;

  // The layer status
  #layerStatus: TypeLayerStatusSimplified;

  // The layer name
  #layerName: TypeLocalizedString | undefined;

  /** Layer temporal dimension */
  #layerTemporalDimension?: TimeDimension;

  /** Date format object used to translate server to ISO format and ISO to server format */
  #serverDateFragmentsOrder?: TypeDateFragments;

  /** Date format object used to translate internal UTC ISO format to the external format, the one used by the user */
  #externalFragmentsOrder?: TypeDateFragments;

  // Keep all callback delegates references
  #onLayerNameChangedHandlers: LayerNameChangedDelegate[] = [];

  // Keep all callback delegate references
  #onLegendQueryingHandlers: LegendQueryingDelegate[] = [];

  // Keep all callback delegate references
  #onLegendQueriedHandlers: LegendQueriedDelegate[] = [];

  // Keep all callback delegate references
  #onVisibleChangedHandlers: VisibleChangedDelegate[] = [];

  // Keep all callback delegate references
  #onLayerFilterAppliedHandlers: LayerFilterAppliedDelegate[] = [];

  /**
   * Constructs a GeoView layer to manage an OpenLayer layer.
   * @param {string} mapId - The map id
   * @param {BaseLayer} olLayer - The OpenLayer layer.
   * @param {AbstractBaseLayerEntryConfig} layerConfig - The layer configuration.
   */
  protected constructor(mapId: string, olLayer: BaseLayer, layerConfig: AbstractBaseLayerEntryConfig) {
    this.#mapId = mapId;
    this.#olLayer = olLayer;
    this.#layerConfig = layerConfig;
    this.#layerName = layerConfig.layerName;
    this.#layerStatus = 'loading';

    // Keep the date formatting information
    this.#serverDateFragmentsOrder = layerConfig.geoviewLayerConfig.serviceDateFormat
      ? DateMgt.getDateFragmentsOrder(layerConfig.geoviewLayerConfig.serviceDateFormat)
      : undefined;
    this.#externalFragmentsOrder = DateMgt.getDateFragmentsOrder(layerConfig.geoviewLayerConfig.externalDateFormat);
  }

  /**
   * Initializes the GVLayer. This function checks if the source is ready and if so it calls onLoaded() to pursue initialization of the layer.
   * If the source isn't ready, it registers to the source ready event to pursue initialization of the layer once its source is ready.
   */
  init(): void {
    // Depending on the instance
    let listenerName;
    if (this.#olLayer instanceof ImageLayer) {
      listenerName = 'image';
    } else if (this.#olLayer instanceof VectorTileLayer) {
      listenerName = 'tile';
    } else if (this.#olLayer instanceof BaseVectorLayer) {
      listenerName = 'features';
    } else {
      // Unsupported
      throw new Error(`Unsupported OpenLayer type: ${this.#olLayer.constructor.name}`);
    }

    // Get the source state
    const sourceState = this.#olLayer.get('source').getState();

    // Check if OpenLayer is loaded, else register an event
    if (sourceState === 'ready') {
      // Already loaded
      this.onLoaded();
    } else if (sourceState === 'error') {
      // Already in error
      this.onError();
    } else {
      // Activation of the load end listeners
      this.#olLayer.get('source').once(`${listenerName}loaderror`, this.onLoaded.bind(this));
      this.#olLayer.get('source').once(`${listenerName}loadend`, this.onError.bind(this));
    }
  }

  /**
   * Gets the Map Id
   * @returns The Map id
   */
  getMapId(): string {
    return this.#mapId;
  }

  /**
   * Gets the MapViewer where the layer resides
   * @returns {MapViewer} The MapViewer
   */
  getMapViewer(): MapViewer {
    // GV The GVLayers need a reference to the MapViewer to be able to perform operations.
    // GV This is a trick to obtain it. Otherwise, it'd need to be provided via constructor.
    return MapEventProcessor.getMapViewer(this.getMapId());
  }

  /**
   * Gets the OpenLayers Layer
   * @returns The OpenLayers Layer
   */
  getOLLayer(): BaseLayer {
    return this.#olLayer;
  }

  /**
   * Gets the OpenLayers Layer Source
   * @returns The OpenLayers Layer Source
   */
  getOLSource(): Source | undefined {
    return this.getOLLayer().get('source') || undefined;
  }

  /**
   * Gets the layer configuration associated with the layer.
   * @returns {AbstractBaseLayerEntryConfig} The layer configuration
   */
  getLayerConfig(): AbstractBaseLayerEntryConfig {
    return this.#layerConfig;
  }

  /**
   * Gets the layer path associated with the layer.
   * @returns {string} The layer path
   */
  getLayerPath(): string {
    return this.#layerConfig.layerPath;
  }

  /**
   * Gets the Geoview layer id.
   * @returns {string} The geoview layer id
   */
  getGeoviewLayerId(): string {
    return this.#layerConfig.geoviewLayerConfig.geoviewLayerId;
  }

  /**
   * Gets the geoview layer name.
   * @returns {AbstractBaseLayerEntryConfig} The layer name
   */
  getGeoviewLayerName(): TypeLocalizedString | undefined {
    return this.#layerConfig.geoviewLayerConfig.geoviewLayerName;
  }

  /**
   * Gets the layer status
   * @returns The layer status
   */
  getLayerStatus(): TypeLayerStatusSimplified {
    return this.#layerStatus;
  }

  /**
   * Gets the layer configuration status
   * @returns The layer status
   */
  getLayerConfigStatus(): TypeLayerStatus {
    return this.#layerConfig.layerStatus;
  }

  /**
   * Gets the layer name
   * @returns The layer status
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getLayerName(layerPath: string): TypeLocalizedString | undefined {
    // TODO: Refactor - After layers refactoring, remove the layerPath parameter here (gotta keep it in the signature for now for the layers-set active switch)
    return this.#layerName;
  }

  /**
   * Sets the layer name
   * @param {TypeLocalizedString | undefined} name - The layer name
   */
  setLayerName(layerPath: string, name: TypeLocalizedString | undefined): void {
    // TODO: Refactor - After layers refactoring, remove the layerPath parameter here (gotta keep it in the signature for now for the layers-set active switch)
    this.#layerName = name;
    this.#emitLayerNameChanged({ layerPath, layerName: name });
  }

  /**
   * Gets the temporal dimension that is associated to the layer.
   * @returns {TimeDimension | undefined} The temporal dimension associated to the layer or undefined.
   */
  getTemporalDimension(): TimeDimension | undefined {
    return this.#layerTemporalDimension;
  }

  /**
   * Sets the temporal dimension for the layer.
   * @param {TimeDimension} temporalDimension - The value to assign to the layer temporal dimension property.
   */
  setTemporalDimension(temporalDimension: TimeDimension): void {
    this.#layerTemporalDimension = temporalDimension;
  }

  /**
   * Gets the external fragments order.
   * @returns {TypeDateFragments | undefined} The external fragmets order associated to the layer or undefined.
   */
  getExternalFragmentsOrder(): TypeDateFragments | undefined {
    return this.#externalFragmentsOrder;
  }

  /**
   * Overridable method called when the layer has been loaded correctly
   */
  protected onLoaded(): void {
    // Set the layer config status to loaded to keep mirroring the AbstractGeoViewLayer for now
    this.#layerConfig.layerStatus = 'loaded';

    // Set the layer status to loaded for the layer
    this.#layerStatus = 'loaded';

    // Now that the layer is loaded, set its visibility correctly (had to be done in the loaded event, not before, per prior note in pre-refactor)
    this.setVisible(this.#layerConfig.initialSettings?.states?.visible !== false);
  }

  /**
   * Overridable method called when the layer is in error and couldn't be loaded correctly
   */
  protected onError(): void {
    // Set the layer config status to error to keep mirroring the AbstractGeoViewLayer for now
    this.#layerConfig.layerStatus = 'error';

    // Set the layer status to error for the layer
    this.#layerStatus = 'error';
  }

  /**
   * Returns feature information for the layer specified.
   * @param {QueryType} queryType - The type of query to perform.
   * @param {TypeLocation} location - An optionsl pixel, coordinate or polygon that will be used by the query.
   * @returns {Promise<TypeFeatureInfoEntry[] | undefined | null>} The feature info table.
   */
  async getFeatureInfo(
    queryType: QueryType,
    layerPath: string,
    location: TypeLocation = null
  ): Promise<TypeFeatureInfoEntry[] | undefined | null> {
    // TODO: Refactor - After layers refactoring, remove the layerPath parameter here (gotta keep it in the signature for now for the layers-set active switch)
    try {
      // Get the layer config
      const layerConfig = this.getLayerConfig();

      // If queryable
      if (!layerConfig.source?.featureInfo?.queryable) {
        logger.logError(`Layer at path ${layerConfig.layerPath} is not queryable`);
        return null;
      }

      // Log
      logger.logTraceCore('ABSTRACT-GV-LAYERS - getFeatureInfo', queryType);
      const logMarkerKey = `${queryType}`;
      logger.logMarkerStart(logMarkerKey);

      let promiseGetFeature: Promise<TypeFeatureInfoEntry[] | undefined | null>;
      switch (queryType) {
        case 'all':
          promiseGetFeature = this.getAllFeatureInfo();
          break;
        case 'at_pixel':
          promiseGetFeature = this.getFeatureInfoAtPixel(location as Pixel);
          break;
        case 'at_coordinate':
          promiseGetFeature = this.getFeatureInfoAtCoordinate(location as Coordinate);
          break;
        case 'at_long_lat':
          promiseGetFeature = this.getFeatureInfoAtLongLat(location as Coordinate);
          break;
        case 'using_a_bounding_box':
          promiseGetFeature = this.getFeatureInfoUsingBBox(location as Coordinate[]);
          break;
        case 'using_a_polygon':
          promiseGetFeature = this.getFeatureInfoUsingPolygon(location as Coordinate[]);
          break;
        default:
          // Default is empty array
          promiseGetFeature = Promise.resolve([]);

          // Log
          logger.logError(`Queries using ${queryType} are invalid.`);
      }

      // Wait for results
      const arrayOfFeatureInfoEntries = await promiseGetFeature;

      // Log
      logger.logMarkerCheck(logMarkerKey, 'to getFeatureInfo', arrayOfFeatureInfoEntries);

      // Return the result
      return arrayOfFeatureInfoEntries;
    } catch (error) {
      // Log
      logger.logError(error);
      return null;
    }
  }

  /**
   * Overridable function to get all feature information for all the features stored in the layer.
   * @returns {Promise<TypeFeatureInfoEntry[] | undefined | null>} A promise of an array of TypeFeatureInfoEntry[].
   */
  protected getAllFeatureInfo(): Promise<TypeFeatureInfoEntry[] | undefined | null> {
    // Crash on purpose
    throw new Error(`Not implemented exception getAllFeatureInfo on layer path ${this.getLayerPath()}`);
  }

  /**
   * Overridable function to return of feature information at a given pixel location.
   * @param {Coordinate} location - The pixel coordinate that will be used by the query.
   * @returns {Promise<TypeFeatureInfoEntry[] | undefined | null>} A promise of an array of TypeFeatureInfoEntry[].
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected getFeatureInfoAtPixel(location: Pixel): Promise<TypeFeatureInfoEntry[] | undefined | null> {
    // Crash on purpose
    throw new Error(`Not implemented exception for getFeatureInfoAtPixel on layer path ${this.getLayerPath()}`);
  }

  /**
   * Overridable function to return of feature information at a given coordinate.
   * @param {Coordinate} location - The coordinate that will be used by the query.
   * @returns {Promise<TypeFeatureInfoEntry[] | undefined | null>} A promise of an array of TypeFeatureInfoEntry[].
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected getFeatureInfoAtCoordinate(location: Coordinate): Promise<TypeFeatureInfoEntry[] | undefined | null> {
    // Crash on purpose
    throw new Error(`Not implemented exception for getFeatureInfoAtCoordinate on layer path ${this.getLayerPath()}`);
  }

  /**
   * Overridable function to return of feature information at the provided long lat coordinate.
   * @param {Coordinate} lnglat - The coordinate that will be used by the query.
   * @returns {Promise<TypeFeatureInfoEntry[] | undefined | null>} A promise of an array of TypeFeatureInfoEntry[].
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected getFeatureInfoAtLongLat(location: Coordinate): Promise<TypeFeatureInfoEntry[] | undefined | null> {
    // Crash on purpose
    throw new Error(`Not implemented exception for getFeatureInfoAtLongLat on layer path ${this.getLayerPath()}`);
  }

  /**
   * Overridable function to return of feature information at the provided bounding box.
   * @param {Coordinate} location - The bounding box that will be used by the query.
   * @returns {Promise<TypeFeatureInfoEntry[] | undefined | null>} A promise of an array of TypeFeatureInfoEntry[].
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected getFeatureInfoUsingBBox(location: Coordinate[]): Promise<TypeFeatureInfoEntry[] | undefined | null> {
    // Crash on purpose
    throw new Error(`Not implemented exception for getFeatureInfoUsingBBox on layer path ${this.getLayerPath()}`);
  }

  /**
   * Overridable function to return of feature information at the provided polygon.
   * @param {Coordinate} location - The polygon that will be used by the query.
   * @returns {Promise<TypeFeatureInfoEntry[] | undefined | null>} A promise of an array of TypeFeatureInfoEntry[].
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected getFeatureInfoUsingPolygon(location: Coordinate[]): Promise<TypeFeatureInfoEntry[] | undefined | null> {
    // Crash on purpose
    throw new Error(`Not implemented exception for getFeatureInfoUsingPolygon on layer path ${this.getLayerPath()}`);
  }

  /**
   * Overridable function to return the domain of the specified field or null if the field has no domain.
   * @param {string} fieldName - The field name for which we want to get the domain.
   * @returns {null | codedValueType | rangeDomainType} The domain of the field.
   */
  protected getFieldDomain(fieldName: string): null | codedValueType | rangeDomainType {
    // Log
    logger.logWarning(`getFieldDomain is not implemented for ${fieldName} on layer path ${this.getLayerPath()}`);
    return null;
  }

  /**
   * Overridable function to return the type of the specified field from the metadata. If the type can not be found, return 'string'.
   * @param {string} fieldName - The field name for which we want to get the type.
   *
   * @returns {'string' | 'date' | 'number'} The type of the field.
   */
  protected getFieldType(fieldName: string): 'string' | 'date' | 'number' {
    // Log
    logger.logWarning(`getFieldType is not implemented for ${fieldName} on layer path ${this.getLayerPath()}`);
    return 'string';
  }

  /**
   * Returns the extent of the layer or undefined if it will be visible regardless of extent. The layer extent is an array of
   * numbers representing an extent: [minx, miny, maxx, maxy].
   * The extent is used to clip the data displayed on the map.
   * @returns {Extent | undefined} The layer extent.
   */
  getExtent(): Extent | undefined {
    return this.getOLLayer().getExtent();
  }

  /**
   * Sets the extent of the layer. Use undefined if it will be visible regardless of extent. The layer extent is an array of
   * numbers representing an extent: [minx, miny, maxx, maxy].
   * @param {Extent} layerExtent The extent to assign to the layer.
   */
  setExtent(layerExtent: Extent): void {
    this.getOLLayer().setExtent(layerExtent);
  }

  /**
   * Gets the opacity of the layer (between 0 and 1).
   * @returns {number} The opacity of the layer.
   */
  getOpacity(): number {
    return this.getOLLayer().getOpacity();
  }

  /**
   * Sets the opacity of the layer (between 0 and 1).
   * @param {number} layerOpacity The opacity of the layer.
   */
  setOpacity(layerOpacity: number): void {
    this.getOLLayer().setOpacity(layerOpacity);
  }

  /**
   * Gets the visibility of the layer (true or false).
   * @returns {boolean} The visibility of the layer.
   */
  getVisible(): boolean {
    return this.getOLLayer().getVisible();
  }

  /**
   * Sets the visibility of the layer (true or false).
   * @param {boolean} layerVisibility The visibility of the layer.
   */
  setVisible(layerVisibility: boolean): void {
    const curVisible = this.getVisible();
    this.getOLLayer().setVisible(layerVisibility);
    if (layerVisibility !== curVisible) this.#emitVisibleChanged({ visible: layerVisibility });
  }

  /**
   * Gets the min zoom of the layer.
   * @returns {number} The min zoom of the layer.
   */
  getMinZoom(): number {
    return this.getOLLayer().getMinZoom();
  }

  /**
   * Sets the min zoom of the layer.
   * @param {number} minZoom The min zoom of the layer.
   */
  setMinZoom(minZoom: number): void {
    this.getOLLayer().setMinZoom(minZoom);
  }

  /**
   * Gets the max zoom of the layer.
   * @returns {number} The max zoom of the layer.
   */
  getMaxZoom(): number {
    return this.getOLLayer().getMaxZoom();
  }

  /**
   * Sets the max zoom of the layer.
   * @param {number} maxZoom The max zoom of the layer.
   */
  setMaxZoom(maxZoom: number): void {
    this.getOLLayer().setMaxZoom(maxZoom);
  }

  /**
   * Queries the legend.
   * This function raises legend querying and queried events. It calls the overridable getLegend() function.
   * @returns {Promise<TypeLegend | null>} The promise when the legend (or null) will be received
   */
  queryLegend(): Promise<TypeLegend | null> {
    // Emit that the legend has been queried
    this.#emitLegendQuerying();

    // Get the legend
    const promiseLegend = this.getLegend();

    // Whenever the promise resolves
    promiseLegend
      .then((legend) => {
        // If legend was received
        if (legend) {
          // Emit legend information once retrieved
          this.#emitLegendQueried({ legend });
        }
      })
      .catch((error) => {
        // Log
        logger.logPromiseFailed('promiseLegend in queryLegend in AbstractGVLayer', error);
      });

    // Return the promise
    return promiseLegend;
  }

  /**
   * Overridable function returning the legend of the layer. Returns null when the layerPath specified is not found. If the style property
   * of the layerConfig object is undefined, the legend property of the object returned will be null.
   * @returns {Promise<TypeLegend | null>} The legend of the layer.
   */
  async getLegend(): Promise<TypeLegend | null> {
    // TODO: Refactor - Layers refactoring. Rename this function to onFetchLegend() once the layers refactoring is done
    try {
      const layerConfig = this.getLayerConfig() as
        | AbstractBaseLayerEntryConfig & {
            style: TypeStyleConfig;
          };

      if (!layerConfig.style) {
        const legend: TypeLegend = {
          type: layerConfig.geoviewLayerConfig.geoviewLayerType,
          layerName: layerConfig.layerName!,
          styleConfig: layerConfig.style,
          legend: null,
        };
        return legend;
      }

      const legend: TypeLegend = {
        type: layerConfig.geoviewLayerConfig.geoviewLayerType,
        layerName: layerConfig?.layerName,
        styleConfig: layerConfig?.style,
        legend: await getLegendStyles(layerConfig),
      };
      return legend;
    } catch (error) {
      // Log
      logger.logError(error);
      return null;
    }
  }

  /**
   * Gets and formats the value of the field with the name passed in parameter. Vector GeoView layers convert dates to milliseconds
   * since the base date. Vector feature dates must be in ISO format.
   * @param {Feature} features - The features that hold the field values.
   * @param {string} fieldName - The field name.
   * @param {'number' | 'string' | 'date'} fieldType - The field type.
   * @returns {string | number | Date} The formatted value of the field.
   */
  protected getFieldValue(feature: Feature, fieldName: string, fieldType: 'number' | 'string' | 'date'): string | number | Date {
    const fieldValue = feature.get(fieldName);
    let returnValue: string | number | Date;
    if (fieldType === 'date') {
      if (typeof fieldValue === 'string') {
        if (!this.#serverDateFragmentsOrder)
          this.#serverDateFragmentsOrder = DateMgt.getDateFragmentsOrder(DateMgt.deduceDateFormat(fieldValue));
        returnValue = DateMgt.applyInputDateFormat(fieldValue, this.#serverDateFragmentsOrder);
      } else {
        // All vector dates are kept internally in UTC.
        returnValue = DateMgt.convertToUTC(`${DateMgt.convertMilisecondsToDate(fieldValue)}Z`);
      }
      const reverseTimeZone = true;
      if (this.#externalFragmentsOrder)
        returnValue = DateMgt.applyOutputDateFormat(returnValue, this.#externalFragmentsOrder, reverseTimeZone);
      return returnValue;
    }
    return fieldValue;
  }

  /**
   * Converts the feature information to an array of TypeFeatureInfoEntry[] | undefined | null.
   * @param {Feature[]} features - The array of features to convert.
   * @param {OgcWmsLayerEntryConfig | EsriDynamicLayerEntryConfig | VectorLayerEntryConfig} layerConfig - The layer configuration.
   * @returns {Promise<TypeFeatureInfoEntry[] | undefined | null>} The Array of feature information.
   */
  protected async formatFeatureInfoResult(
    features: Feature[],
    layerConfig: OgcWmsLayerEntryConfig | EsriDynamicLayerEntryConfig | VectorLayerEntryConfig
  ): Promise<TypeFeatureInfoEntry[] | undefined | null> {
    try {
      if (!features.length) return [];

      // Will hold the generic icon to use in formatting
      let genericLegendInfo: string | null | undefined;
      // We only want 1 task to fetch the generic legend (when we have to)
      const semaphore = new AsyncSemaphore(1);

      // Will be executed when we have to use a default canvas for a particular feature
      const callbackToFetchDataUrl = (): Promise<string | null> => {
        // Make sure one task at a time in this
        return semaphore.withLock(async () => {
          // Only execute this once in the callback. After this, once the semaphore is unlocked, it's either a string or null for as long as we're formatting
          if (genericLegendInfo === undefined) {
            genericLegendInfo = null; // Turn it to null, we are actively trying to find something (not undefined anymore)
            const legend = await this.queryLegend();
            const legendIcons = LegendEventProcessor.getLayerIconImage(legend);
            if (legendIcons) genericLegendInfo = legendIcons![0].iconImage || null;
          }
          return genericLegendInfo;
        });
      };

      const featureInfo = layerConfig?.source?.featureInfo;
      const fieldTypes = featureInfo?.fieldTypes?.split(',') as ('string' | 'number' | 'date')[];
      // TODO: Refactor - Remove the 2 hardcoded 'en' here
      const outfields = getLocalizedValue(featureInfo?.outfields as TypeLocalizedString, 'en')?.split(',');
      const aliasFields = getLocalizedValue(featureInfo?.aliasFields as TypeLocalizedString, 'en')?.split(',');

      // Loop on the features to build the array holding the promises for their canvas
      const promisedAllCanvasFound: Promise<{ feature: Feature; canvas: HTMLCanvasElement }>[] = [];
      features.forEach((featureNeedingItsCanvas) => {
        promisedAllCanvasFound.push(
          new Promise((resolveCanvas) => {
            getFeatureCanvas(featureNeedingItsCanvas, layerConfig, callbackToFetchDataUrl)
              .then((canvas) => {
                resolveCanvas({ feature: featureNeedingItsCanvas, canvas });
              })
              .catch((error) => {
                // Log
                logger.logPromiseFailed(
                  'getFeatureCanvas in featureNeedingItsCanvas loop in formatFeatureInfoResult in AbstractGeoViewLayer',
                  error
                );
              });
          })
        );
      });

      // Hold a dictionary built on the fly for the field domains
      const dictFieldDomains: { [fieldName: string]: codedValueType | rangeDomainType | null } = {};
      // Hold a dictionary build on the fly for the field types
      const dictFieldTypes: { [fieldName: string]: 'string' | 'number' | 'date' } = {};

      // Loop on the promised feature infos
      let featureKeyCounter = 0;
      let fieldKeyCounter = 0;
      const queryResult: TypeFeatureInfoEntry[] = [];
      const arrayOfFeatureInfo = await Promise.all(promisedAllCanvasFound);
      arrayOfFeatureInfo.forEach(({ feature, canvas }) => {
        let extent;
        if (feature.getGeometry()) extent = feature.getGeometry()!.getExtent();

        // TODO: Refactor - Remove the hardcoded 'en' here
        const featureInfoEntry: TypeFeatureInfoEntry = {
          // feature key for building the data-grid
          featureKey: featureKeyCounter++,
          geoviewLayerType: this.getLayerConfig().geoviewLayerConfig.geoviewLayerType,
          extent,
          geometry: feature,
          featureIcon: canvas,
          fieldInfo: {},
          nameField: getLocalizedValue(layerConfig?.source?.featureInfo?.nameField as TypeLocalizedString, 'en') || null,
        };

        const featureFields = feature.getKeys();
        featureFields.forEach((fieldName) => {
          if (fieldName !== 'geometry') {
            // Calculate the field domain if not already calculated
            if (!(fieldName in dictFieldDomains)) {
              // Calculate it
              dictFieldDomains[fieldName] = this.getFieldDomain(fieldName);
            }
            const fieldDomain = dictFieldDomains[fieldName];

            // Calculate the field type if not already calculated
            if (!(fieldName in dictFieldTypes)) {
              dictFieldTypes[fieldName] = this.getFieldType(fieldName);
            }
            const fieldType = dictFieldTypes[fieldName];

            if (outfields?.includes(fieldName)) {
              const fieldIndex = outfields.indexOf(fieldName);
              featureInfoEntry.fieldInfo[fieldName] = {
                fieldKey: fieldKeyCounter++,
                value: this.getFieldValue(feature, fieldName, fieldTypes![fieldIndex]),
                dataType: fieldTypes![fieldIndex] as 'string' | 'date' | 'number',
                alias: aliasFields![fieldIndex],
                domain: fieldDomain,
              };
            } else if (!outfields) {
              featureInfoEntry.fieldInfo[fieldName] = {
                fieldKey: fieldKeyCounter++,
                value: this.getFieldValue(feature, fieldName, fieldType),
                dataType: fieldType,
                alias: fieldName,
                domain: fieldDomain,
              };
            }
          }
        });
        queryResult.push(featureInfoEntry);
      });
      return queryResult;
    } catch (error) {
      // Log
      logger.logError(error);
      return [];
    }
  }

  /**
   * Gets the layerFilter that is associated to the layer.
   * @returns {string | undefined} The filter associated to the layer or undefined.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getLayerFilter(layerPath: string): string | undefined {
    // TODO: Refactor - After layers refactoring, remove the layerPath parameter here (gotta keep it in the signature for now for the layers-set active switch)
    const layerConfig = this.getLayerConfig();
    // TODO: Refactor to put the 'layerFilter' at the right place. Meanwhile, using `any` here
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (layerConfig as any)?.layerFilter;
  }

  /**
   * Emits an event to all handlers.
   * @param {LayerNameChangedEvent} event - The event to emit
   * @private
   */
  #emitLayerNameChanged(event: LayerNameChangedEvent): void {
    // Emit the event for all handlers
    EventHelper.emitEvent(this, this.#onLayerNameChangedHandlers, event);
  }

  /**
   * Registers a layer name changed event handler.
   * @param {LayerNameChangedDelegate} callback - The callback to be executed whenever the event is emitted
   */
  onLayerNameChanged(callback: LayerNameChangedDelegate): void {
    // Register the event handler
    EventHelper.onEvent(this.#onLayerNameChangedHandlers, callback);
  }

  /**
   * Unregisters a layer name changed event handler.
   * @param {LayerNameChangedDelegate} callback - The callback to stop being called whenever the event is emitted
   */
  offLayerNameChanged(callback: LayerNameChangedDelegate): void {
    // Unregister the event handler
    EventHelper.offEvent(this.#onLayerNameChangedHandlers, callback);
  }

  /**
   * Emits an event to all handlers.
   * @param {LegendQueryingEvent} event The event to emit
   * @private
   */
  #emitLegendQuerying(): void {
    // Emit the event for all handlers
    EventHelper.emitEvent(this, this.#onLegendQueryingHandlers, undefined);
  }

  /**
   * Registers a legend querying event handler.
   * @param {LegendQueryingDelegate} callback The callback to be executed whenever the event is emitted
   */
  onLegendQuerying(callback: LegendQueryingDelegate): void {
    // Register the event handler
    EventHelper.onEvent(this.#onLegendQueryingHandlers, callback);
  }

  /**
   * Unregisters a legend querying event handler.
   * @param {LegendQueryingDelegate} callback The callback to stop being called whenever the event is emitted
   */
  offLegendQuerying(callback: LegendQueryingDelegate): void {
    // Unregister the event handler
    EventHelper.offEvent(this.#onLegendQueryingHandlers, callback);
  }

  /**
   * Emits an event to all handlers.
   * @param {LegendQueriedEvent} event The event to emit
   * @private
   */
  #emitLegendQueried(event: LegendQueriedEvent): void {
    // Emit the event for all handlers
    EventHelper.emitEvent(this, this.#onLegendQueriedHandlers, event);
  }

  /**
   * Registers a legend queried event handler.
   * @param {LegendQueriedDelegate} callback The callback to be executed whenever the event is emitted
   */
  onLegendQueried(callback: LegendQueriedDelegate): void {
    // Register the event handler
    EventHelper.onEvent(this.#onLegendQueriedHandlers, callback);
  }

  /**
   * Unregisters a legend queried event handler.
   * @param {LegendQueriedDelegate} callback The callback to stop being called whenever the event is emitted
   */
  offLegendQueried(callback: LegendQueriedDelegate): void {
    // Unregister the event handler
    EventHelper.offEvent(this.#onLegendQueriedHandlers, callback);
  }

  /**
   * Emits an event to all handlers.
   * @param {VisibleChangedEvent} event The event to emit
   * @private
   */
  #emitVisibleChanged(event: VisibleChangedEvent): void {
    // Emit the event for all handlers
    EventHelper.emitEvent(this, this.#onVisibleChangedHandlers, event);
  }

  /**
   * Registers a visible changed event handler.
   * @param {VisibleChangedDelegate} callback The callback to be executed whenever the event is emitted
   */
  onVisibleChanged(callback: VisibleChangedDelegate): void {
    // Register the event handler
    EventHelper.onEvent(this.#onVisibleChangedHandlers, callback);
  }

  /**
   * Unregisters a visible changed event handler.
   * @param {VisibleChangedDelegate} callback The callback to stop being called whenever the event is emitted
   */
  offVisibleChanged(callback: VisibleChangedDelegate): void {
    // Unregister the event handler
    EventHelper.offEvent(this.#onVisibleChangedHandlers, callback);
  }

  /**
   * Emits filter applied event.
   * @param {FilterAppliedEvent} event - The event to emit
   * @private
   */
  protected emitLayerFilterApplied(event: LayerFilterAppliedEvent): void {
    // Emit the event for all handlers
    EventHelper.emitEvent(this, this.#onLayerFilterAppliedHandlers, event);
  }

  /**
   * Registers a filter applied event handler.
   * @param {FilterAppliedDelegate} callback - The callback to be executed whenever the event is emitted
   */
  onLayerFilterApplied(callback: LayerFilterAppliedDelegate): void {
    // Register the event handler
    EventHelper.onEvent(this.#onLayerFilterAppliedHandlers, callback);
  }

  /**
   * Unregisters a filter applied event handler.
   * @param {FilterAppliedDelegate} callback - The callback to stop being called whenever the event is emitted
   */
  offLayerFilterApplied(callback: LayerFilterAppliedDelegate): void {
    // Unregister the event handler
    EventHelper.offEvent(this.#onLayerFilterAppliedHandlers, callback);
  }
}

/**
 * Define an event for the delegate.
 */
export type LayerNameChangedEvent = {
  // The new layer name.
  layerName?: TypeLocalizedString;
  // TODO: Refactor - Layers refactoring. Remove the layerPath parameter once hybrid work is done
  // The layer path.
  layerPath: string;
};

/**
 * Define a delegate for the event handler function signature.
 */
type LayerNameChangedDelegate = EventDelegateBase<AbstractGVLayer, LayerNameChangedEvent>;

/**
 * Define an event for the delegate
 */
export type LegendQueryingEvent = unknown;

/**
 * Define a delegate for the event handler function signature
 */
type LegendQueryingDelegate = EventDelegateBase<AbstractGVLayer, LegendQueryingEvent>;

/**
 * Define an event for the delegate
 */
export type LegendQueriedEvent = {
  legend: TypeLegend;
};

/**
 * Define a delegate for the event handler function signature
 */
type LegendQueriedDelegate = EventDelegateBase<AbstractGVLayer, LegendQueriedEvent>;

/**
 * Define an event for the delegate
 */
export type VisibleChangedEvent = {
  visible: boolean;
};

/**
 * Define a delegate for the event handler function signature
 */
type VisibleChangedDelegate = EventDelegateBase<AbstractGVLayer, VisibleChangedEvent>;

/**
 * Define a delegate for the event handler function signature
 */
type LayerFilterAppliedDelegate = EventDelegateBase<AbstractGVLayer, LayerFilterAppliedEvent>;

/**
 * Define an event for the delegate
 */
export type LayerFilterAppliedEvent = {
  // The layer path of the affected layer
  layerPath: string;
  // The filter
  filter: string;
};
