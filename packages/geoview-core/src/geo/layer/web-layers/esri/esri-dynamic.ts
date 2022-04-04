import axios from 'axios';

import L from 'leaflet';

import { DynamicMapLayer, DynamicMapLayerOptions, dynamicMapLayer, mapService as esriMapService, MapService } from 'esri-leaflet';

import { getXMLHttpRequest } from '../../../../core/utils/utilities';
import {
  Cast,
  AbstractWebLayersClass,
  TypeLayerConfig,
  TypeJsonValue,
  TypeJsonObject,
  TypeJsonArray,
  TypeLegendJsonDynamic,
} from '../../../../core/types/cgpv-types';

import { api } from '../../../../api/api';

/**
 * a class to add esri dynamic layer
 *
 * @export
 * @class EsriDynamic
 */
export class EsriDynamic extends AbstractWebLayersClass {
  // layer from leaflet
  layer: DynamicMapLayer | null = null;

  // mapService property
  mapService: MapService;

  // service entries
  entries?: number[];

  /**
   * Initialize layer
   *
   * @param {TypeLayerConfig} layerConfig the layer configuration
   */
  constructor(layerConfig: TypeLayerConfig) {
    super('esriDynamic', 'Esri Dynamic Layer', layerConfig);

    const entries = layerConfig.entries?.split(',').map((item: string) => {
      return parseInt(item, 10);
    });

    this.entries = entries?.filter((item) => !Number.isNaN(item));

    this.mapService = esriMapService({
      url: api.geoUtilities.getMapServerUrl(layerConfig.url),
    });
  }

  /**
   * Add a ESRI dynamic layer to the map.
   *
   * @param {TypeLayerConfig} layer the layer configuration
   * @return {Promise<DynamicMapLayer | null>} layers to add to the map
   */
  add(layer: TypeLayerConfig): Promise<DynamicMapLayer | null> {
    const data = getXMLHttpRequest(`${layer.url}?f=json`);

    const geo = new Promise<DynamicMapLayer | null>((resolve) => {
      data.then((value: string) => {
        // get layers from service and parse layer entries as number
        const { layers } = JSON.parse(value) as TypeJsonObject;

        // check if the entries are part of the service
        if (
          value !== '{}' &&
          layers &&
          Cast<TypeJsonValue[]>(layers).find((item) => {
            const searchedItem = (item as { [key: string]: { id: string } }).id;
            return this.entries?.includes(Cast<number>(searchedItem));
          })
        ) {
          const feature = dynamicMapLayer({
            url: layer.url,
            layers: this.entries,
            attribution: '',
          } as DynamicMapLayerOptions);

          resolve(feature);
        } else {
          resolve(null);
        }
      });
    });

    return geo;
  }

  /**
   * Get metadata of the current service
   *
   @returns {Promise<TypeJsonValue>} a json promise containing the result of the query
   */
  getMetadata = async (): Promise<TypeJsonObject> => {
    // const feat = featureLayer({
    //   url: this.url,
    // });
    // return feat.metadata(function (error, metadata) {
    //   return metadata;
    // });
    const response = await fetch(`${this.url}?f=json`);
    const result: TypeJsonObject = await response.json();

    return result;
  };

  /**
   * Get legend configuration of the current layer
   *
   * @returns {TypeJsonValue} legend configuration in json format
   */
  getLegendJson = (): Promise<TypeJsonArray> => {
    let queryUrl = this.url.substr(-1) === '/' ? this.url : `${this.url}/`;
    queryUrl += 'legend?f=pjson';

    const feat = dynamicMapLayer({
      url: this.url,
      layers: this.entries,
      attribution: '',
    });

    return axios.get<TypeJsonObject>(queryUrl).then<TypeJsonArray>((res) => {
      const { data } = res;
      const entryArray = feat.getLayers();

      if (entryArray.length > 0) {
        const result = (data.layers as TypeJsonArray).filter((item) => {
          return entryArray.includes((item as TypeJsonObject).layerId) as TypeJsonArray;
        });
        return result as TypeJsonArray;
      }
      return data.layers as TypeJsonArray;
    });
  };

  /**
   * Set Layer Opacity
   * @param {number} opacity layer opacity
   */
  setOpacity = (opacity: number) => {
    (this.layer as DynamicMapLayer).setOpacity(opacity);
  };

  /**
   * Fetch the bounds for an entry
   *
   * @param {number} entry
   * @returns {TypeJsonValue} the result of the fetch
   */
  private getEntry = async (entry: number): Promise<TypeLegendJsonDynamic> => {
    const response = await fetch(`${this.url}/${entry}?f=json`);
    const meta = await response.json();

    return meta;
  };

  /**
   * Get bounds through external metadata
   *
   * @returns {Promise<L.LatLngBounds>} layer bounds
   */
  getBounds = async (): Promise<L.LatLngBounds> => {
    const bounds = L.latLngBounds([]);
    if (this.entries) {
      this.entries.forEach(async (entry: number) => {
        const meta = await this.getEntry(entry);

        const { xmin, xmax, ymin, ymax } = meta.extent;
        bounds.extend([
          [ymin, xmin],
          [ymax, xmax],
        ]);
      });
    }

    return bounds;
  };

  /**
   * Sets Layer entries to toggle sublayers
   *
   * @param entries MapServer layer IDs
   */
  setEntries = (entries: number[]) => {
    (this.layer as DynamicMapLayer).options.layers = entries;
    (this.layer as DynamicMapLayer).redraw();
  };
}